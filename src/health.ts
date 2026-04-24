import http from "node:http";
import { createLogger } from "./logger.js";

const log = createLogger("health");

let lastScan: string | null = null;

export function setLastScanTime(time: string | null): void {
  lastScan = time;
}

export function createHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const body = JSON.stringify({
        status: "ok",
        lastScan,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    log.info(`Health check server listening on port ${port}`);
  });

  return server;
}
