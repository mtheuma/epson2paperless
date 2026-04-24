import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { uploadAllToPaperless } from "./paperless-upload.js";

function makeFiles(names: string[]): { dir: string; paths: string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperless-upload-test-"));
  const paths = names.map((n) => {
    const p = path.join(dir, n);
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG
    return p;
  });
  return { dir, paths };
}

describe("uploadAllToPaperless", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads a single file with correct URL, headers, and form field", async () => {
    fetchMock.mockResolvedValueOnce(new Response("task-uuid-123", { status: 201 }));
    const { dir, paths } = makeFiles(["scan_2026-04-23.jpg"]);
    try {
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000",
        token: "abc123",
        deleteAfterUpload: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://paperless.lan:8000/api/documents/post_document/");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Token abc123" });
      const formData = init.body as FormData;
      expect(formData.get("document")).toBeInstanceOf(Blob);
      expect(existsSync(paths[0])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes the local file after upload when deleteAfterUpload is true", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 201 }));
    const { dir, paths } = makeFiles(["scan.pdf"]);
    try {
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000",
        token: "abc123",
        deleteAfterUpload: true,
      });
      expect(existsSync(paths[0])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads N files in parallel", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    fetchMock.mockImplementation(async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 20));
      concurrentCalls--;
      return new Response("ok", { status: 201 });
    });
    const { dir, paths } = makeFiles(["a.jpg", "b.jpg", "c.jpg"]);
    try {
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000",
        token: "t",
        deleteAfterUpload: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(maxConcurrent).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when an upload returns a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    const { dir, paths } = makeFiles(["scan.jpg"]);
    try {
      await expect(
        uploadAllToPaperless(paths, {
          url: "http://paperless.lan:8000",
          token: "bad",
          deleteAfterUpload: true,
        }),
      ).resolves.toBeUndefined();
      expect(existsSync(paths[0])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with partial failure, only successful uploads are deleted", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("ok", { status: 201 })) // a → success
      .mockResolvedValueOnce(new Response("server down", { status: 500 })) // b → fail
      .mockResolvedValueOnce(new Response("ok", { status: 201 })); // c → success
    const { dir, paths } = makeFiles(["a.jpg", "b.jpg", "c.jpg"]);
    try {
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000",
        token: "t",
        deleteAfterUpload: true,
      });
      expect(existsSync(paths[0])).toBe(false);
      expect(existsSync(paths[1])).toBe(true);
      expect(existsSync(paths[2])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when fetch itself rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { dir, paths } = makeFiles(["scan.jpg"]);
    try {
      await expect(
        uploadAllToPaperless(paths, {
          url: "http://paperless.lan:8000",
          token: "t",
          deleteAfterUpload: true,
        }),
      ).resolves.toBeUndefined();
      expect(existsSync(paths[0])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak the auth token into logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      const { dir, paths } = makeFiles(["scan.jpg"]);
      try {
        await uploadAllToPaperless(paths, {
          url: "http://paperless.lan:8000",
          token: "secret-token-xyz",
          deleteAfterUpload: false,
        });
        const allLogArgs = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()]
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join("\n");
        expect(allLogArgs).not.toContain("secret-token-xyz");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("handles various URL shapes correctly (trailing slash, sub-path)", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 201 }));
    const { dir, paths } = makeFiles(["scan.jpg"]);
    try {
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000",
        token: "t",
        deleteAfterUpload: false,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://paperless.lan:8000/api/documents/post_document/",
      );

      fetchMock.mockClear();
      await uploadAllToPaperless(paths, {
        url: "http://paperless.lan:8000/",
        token: "t",
        deleteAfterUpload: false,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://paperless.lan:8000/api/documents/post_document/",
      );

      fetchMock.mockClear();
      await uploadAllToPaperless(paths, {
        url: "http://host.lan/paperless",
        token: "t",
        deleteAfterUpload: false,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://host.lan/paperless/api/documents/post_document/",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
