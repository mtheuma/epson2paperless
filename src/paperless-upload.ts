import { readFileSync, unlinkSync } from "node:fs";
import { basename, extname } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("paperless");

const UPLOAD_PATH = "/api/documents/post_document/";

export interface PaperlessUploadOptions {
  /** Base URL of the Paperless-ngx instance, e.g. "http://paperless:8000". */
  url: string;
  /**
   * API token. Sent as `Authorization: Token <value>`. Never logged —
   * if a future debug-tracing layer is added to fetch calls elsewhere,
   * that code path must redact this header explicitly.
   */
  token: string;
  /** When true, unlink a file after a successful upload of that file. */
  deleteAfterUpload: boolean;
}

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function buildUploadUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed + UPLOAD_PATH;
}

async function uploadOne(filePath: string, opts: PaperlessUploadOptions): Promise<void> {
  const bytes = readFileSync(filePath);
  const blob = new Blob([bytes], { type: contentTypeFor(filePath) });
  const form = new FormData();
  form.append("document", blob, basename(filePath));

  const response = await fetch(buildUploadUrl(opts.url), {
    method: "POST",
    headers: { Authorization: `Token ${opts.token}` },
    body: form,
  });

  const body = await response.text();
  if (response.status === 200 || response.status === 201) {
    log.info(`Paperless upload complete: ${basename(filePath)} → ${body.trim()}`);
    if (opts.deleteAfterUpload) {
      unlinkSync(filePath);
      log.debug(`Deleted local file after upload: ${filePath}`);
    }
    return;
  }

  // Intentional: do not throw. The scan is complete because the local
  // file was written before this function was called.
  log.error(
    `Paperless upload failed for ${basename(filePath)}: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`,
  );
}

export async function uploadAllToPaperless(
  filePaths: string[],
  opts: PaperlessUploadOptions,
): Promise<void> {
  log.info(`Uploading ${filePaths.length} file(s) to Paperless-ngx`);
  await Promise.allSettled(
    filePaths.map((p) =>
      uploadOne(p, opts).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Paperless upload failed for ${basename(p)}: ${msg}`);
      }),
    ),
  );
}
