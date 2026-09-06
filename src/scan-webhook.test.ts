// Wiring tests for the POST /scan webhook (issue #137, plan §5.1). Everything
// is real except the printer target and the scan dispatch: the HTTP server,
// the inflight tracker, the panel-side admission gate and the shutdown drain.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

vi.mock("./job-control.js", () => ({
  runJobListCommit: vi.fn(() => Promise.resolve()),
  runJobNumberCommit: vi.fn(() => Promise.resolve(Buffer.from("0300020000020001", "hex"))),
}));
import { createHealthServer, setLastScanTime } from "./health.js";
import {
  createInflightTracker,
  shutdown,
  __resetShutdownStateForTesting,
  type InflightTracker,
} from "./lifecycle.js";
import {
  buildDaemonPushScanCallback,
  buildPushScanServerOptions,
  buildScanTriggerOptions,
} from "./startup.js";
import type { Config } from "./config.js";
import type { DispatchArgs } from "./startup.js";
import type { PushScanInfo } from "./pushscan.js";
import { createScanAdmission, type ScanAdmission } from "./scan-admission.js";
import { runJobNumberCommit } from "./job-control.js";
import { PID_FF680W, PID_DS575W } from "./printer-ids.js";

const runJobNumberCommitMock = vi.mocked(runJobNumberCommit);

const TOKEN = "t0ken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    printerIp: "192.0.2.5",
    printerHostname: undefined,
    scanDestName: "Paperless",
    scanDestId: 0x02,
    outputDir: "/test-output",
    healthPort: 3000,
    logLevel: "info",
    logFormat: "text",
    language: "en",
    jpegQuality: 90,
    previewAction: "reject",
    postProcess: "none",
    scanFormat: "pdf",
    scanSides: "duplex",
    scanResolution: 200,
    scanColorMode: "color",
    printerProtocol: "auto",
    diagnoseProtocol: false,
    tempDir: "",
    shutdownTimeoutMs: 30000,
    paperlessDeleteAfterUpload: true,
    scanTriggerToken: TOKEN,
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function post(base: string, path = "/scan"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: "POST", headers: AUTH }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

const PANEL_INFO: PushScanInfo = {
  pushScanId: "02",
  jobNumber: null,
  productName: "PID 11D1",
  ipAddress: "C0A8013A",
  duplex: false,
  action: "pdf",
};

interface Harness {
  base: string;
  server: http.Server;
  inflight: InflightTracker;
  dispatch: ReturnType<typeof vi.fn<(args: DispatchArgs) => Promise<void>>>;
  targetCalls: number;
  admission: ScanAdmission;
}

async function harness(opts: {
  config?: Config;
  target?: () => Promise<string>;
  dispatch?: (args: DispatchArgs) => Promise<void>;
}): Promise<Harness> {
  const config = opts.config ?? makeConfig();
  const inflight = createInflightTracker();
  const admission = createScanAdmission(inflight);
  const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(
    opts.dispatch ?? (() => Promise.resolve()),
  );
  const state = { targetCalls: 0 };
  const targetFn = opts.target ?? (() => Promise.resolve("192.0.2.5"));
  const scanTrigger = buildScanTriggerOptions({
    config,
    target: {
      target: () => {
        state.targetCalls++;
        return targetFn();
      },
    },
    admission,
    dispatch,
  });
  const server = createHealthServer(0, { scanTrigger });
  await new Promise<void>((r) => server.once("listening", r));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    inflight,
    dispatch,
    get targetCalls() {
      return state.targetCalls;
    },
    admission,
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("scan webhook wiring", () => {
  let h: Harness | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetShutdownStateForTesting();
    setLastScanTime(null);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    h?.server.close();
    h = undefined;
    warnSpy.mockRestore();
  });

  it("is disabled (undefined) when no token is configured", () => {
    const options = buildScanTriggerOptions({
      config: makeConfig({ scanTriggerToken: undefined }),
      target: { target: () => Promise.resolve("192.0.2.5") },
      admission: createScanAdmission(createInflightTracker()),
    });
    expect(options).toBeUndefined();
  });

  it("dispatches with the resolved target and scan:now-equivalent arguments", async () => {
    h = await harness({ target: () => Promise.resolve("198.51.100.7") });
    expect(await post(h.base, "/scan?format=jpg&sides=simplex")).toBe(202);
    await settle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const args = h.dispatch.mock.calls[0][0];
    expect(args.printerIp).toBe("198.51.100.7");
    expect(args.productName).toBeNull();
    expect(args.action).toBe("jpg");
    expect(args.duplex).toBe(false);
  });

  it("stamps lastScan on acceptance", async () => {
    h = await harness({});
    expect(await post(h.base)).toBe(202);
    const res = await new Promise<string>((resolve) =>
      http.get(`${h!.base}/health`, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve(d));
      }),
    );
    expect(JSON.parse(res).lastScan).not.toBeNull();
  });

  it("two overlapping POSTs → one dispatch, one 202, one 409", async () => {
    const scan = deferred();
    h = await harness({ dispatch: () => scan.promise });
    const [a, b] = await Promise.all([post(h.base), post(h.base)]);
    expect([a, b].sort()).toEqual([202, 409]);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    scan.resolve();
  });

  it("stays busy while target resolution is still pending", async () => {
    const target = deferred<string>();
    h = await harness({ target: () => target.promise });
    expect(await post(h.base)).toBe(202);
    expect(h.dispatch).not.toHaveBeenCalled(); // still awaiting target()
    expect(await post(h.base)).toBe(409);
    target.resolve("192.0.2.5");
    await settle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a webhook scan makes the panel gate refuse PushScan but not JobList", async () => {
    const scan = deferred();
    h = await harness({ dispatch: () => scan.promise });
    expect(await post(h.base)).toBe(202);
    const panel = buildPushScanServerOptions(makeConfig(), undefined, h.admission);
    const hookArgs = (kind: "pushScan" | "jobList") => ({
      kind,
      headers: "",
      body: "",
      xuid: "1",
      info: PANEL_INFO,
      capabilities: [] as string[],
      peerAddress: "192.0.2.5",
    });
    await expect(panel.beforeResponse?.(hookArgs("pushScan"))).rejects.toThrow(/in flight/);
    await expect(panel.beforeResponse?.(hookArgs("jobList"))).resolves.toBeUndefined();
    scan.resolve();
    await settle();
    // Idle again: the panel is admitted and now holds the slot via a reservation.
    const release = await panel.beforeResponse?.(hookArgs("pushScan"));
    expect(typeof release).toBe("function");
    expect(await post(h.base)).toBe(409);
    (release as () => void)();
    expect(await post(h.base)).toBe(202);
  });

  it("a tracked panel scan makes the webhook answer 409", async () => {
    h = await harness({});
    const panelScan = deferred();
    void h.inflight.track(panelScan.promise);
    expect(await post(h.base)).toBe(409);
    panelScan.resolve();
    await settle();
    expect(await post(h.base)).toBe(202);
  });

  it("releases the busy state when target resolution fails", async () => {
    let first = true;
    h = await harness({
      target: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("ENOTFOUND"));
        }
        return Promise.resolve("192.0.2.5");
      },
    });
    expect(await post(h.base)).toBe(202);
    await settle();
    expect(h.inflight.count).toBe(0);
    expect(await post(h.base)).toBe(202);
    await settle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("releases the busy state when the scan fails", async () => {
    let calls = 0;
    h = await harness({
      dispatch: () =>
        ++calls === 1 ? Promise.reject(new Error("scan failed")) : Promise.resolve(),
    });
    expect(await post(h.base)).toBe(202);
    await settle();
    expect(h.inflight.count).toBe(0);
    expect(await post(h.base)).toBe(202);
    await settle();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  const hookArgs = (info: PushScanInfo) => ({
    kind: "pushScan" as const,
    headers: "",
    body: "",
    xuid: "1",
    info,
    capabilities: [] as string[],
    peerAddress: "192.0.2.5",
  });
  const jobInfo = (productName: string): PushScanInfo => ({
    pushScanId: null,
    jobNumber: "0",
    productName,
    ipAddress: "C0A80A08",
    duplex: false,
    action: "unknown",
  });

  for (const [model, pid] of [
    ["FF-680W", PID_FF680W],
    ["DS-575W", PID_DS575W],
  ] as const) {
    it(`${model}: a webhook during the panel's JOBR round-trip gets 409, and only the panel scans`, async () => {
      h = await harness({ dispatch: () => new Promise<void>(() => {}) });
      let finishJobr!: (b: Buffer) => void;
      runJobNumberCommitMock.mockImplementationOnce(
        () =>
          new Promise<Buffer>((r) => {
            finishJobr = r;
          }),
      );
      const config = makeConfig();
      const panel = buildPushScanServerOptions(config, undefined, h.admission);
      // The daemon's real callback, with only the scan dispatch stubbed out.
      const panelDispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(
        () => new Promise<void>(() => {}),
      );
      const onPushScan = buildDaemonPushScanCallback({
        config,
        admission: h.admission,
        dispatch: panelDispatch,
      });
      const pendingHook = panel.beforeResponse!(hookArgs(jobInfo(pid)));
      await settle(); // panel is now waiting on JOBR over 1865

      expect(await post(h.base)).toBe(409);
      expect(h.dispatch).not.toHaveBeenCalled();

      finishJobr(Buffer.from("0300020000020001", "hex"));
      const release = await pendingHook;
      expect(typeof release).toBe("function");
      // Still held between OK and the callback: the webhook stays out.
      expect(await post(h.base)).toBe(409);

      // The daemon callback commits the real scan; the hold converts to a tracked scan.
      onPushScan(jobInfo(pid), "192.0.2.5");
      expect(panelDispatch).toHaveBeenCalledTimes(1);
      expect(await post(h.base)).toBe(409);
      expect(h.dispatch).not.toHaveBeenCalled();
    });
  }

  it("a panel trigger whose dispatch is skipped (preview reject) releases the slot", async () => {
    h = await harness({});
    const config = makeConfig();
    const panel = buildPushScanServerOptions(config, undefined, h.admission);
    const panelDispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(() => Promise.resolve());
    const onPushScan = buildDaemonPushScanCallback({
      config,
      admission: h.admission,
      dispatch: panelDispatch,
    });
    // A non-job-control product sending JobNumberIn with no PushScanIDIn is
    // ignored, so this trigger reaches the callback's reject arm.
    const release = await panel.beforeResponse!(hookArgs(jobInfo("PID 11D1")));
    expect(typeof release).toBe("function");
    expect(await post(h.base)).toBe(409);
    onPushScan(jobInfo("PID 11D1"), "192.0.2.5");
    expect(panelDispatch).not.toHaveBeenCalled();
    expect(await post(h.base)).toBe(202);
  });

  it("a panel trigger that ends without a callback releases the slot via the hook", async () => {
    h = await harness({});
    const panel = buildPushScanServerOptions(makeConfig(), undefined, h.admission);
    const release = (await panel.beforeResponse!(hookArgs(jobInfo("PID 11D1")))) as () => void;
    expect(await post(h.base)).toBe(409);
    release(); // what pushscan.ts does on socket close without a callback
    expect(await post(h.base)).toBe(202);
  });

  it("participates in graceful shutdown: the drain waits for the webhook scan", async () => {
    const scan = deferred();
    h = await harness({ dispatch: () => scan.promise });
    expect(await post(h.base)).toBe(202);
    await settle();

    const order: string[] = [];
    const exits: number[] = [];
    const done = shutdown({
      pushscanServer: { close: () => order.push("pushscan") },
      healthServer: { close: () => order.push("health") },
      responder: { stop: () => order.push("responder") },
      inflight: h.inflight,
      shutdownTimeoutMs: 5000,
      signal: "SIGTERM",
      exit: (code) => exits.push(code),
    });
    await settle();
    expect(order).toEqual(["pushscan"]);
    scan.resolve();
    await done;
    expect(order).toEqual(["pushscan", "health", "responder"]);
    expect(exits).toEqual([0]);
  });
});
