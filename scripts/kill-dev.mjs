#!/usr/bin/env node
// Find and kill any process holding the push-scan TCP port (2968).
//
// Workaround for the case where Claude Code's TaskStop kills the outer
// shell of a piped command (e.g. `npx tsx … | grep …`) but not the Node
// child — on Windows there are no true process groups and the npx → node
// chain has no Job Object wrapping, so the Node process is orphaned with
// its listening sockets still bound. See docs/notes/2026-04-21-taskstop-zombie-tsx.md.

import { execSync } from "node:child_process";

const PORT = 2968;

const out = execSync("netstat -ano", { encoding: "utf8" });
const pids = new Set();
for (const line of out.split(/\r?\n/)) {
  if (!line.includes("LISTENING")) continue;
  if (!new RegExp(`[:.]${PORT}\\b`).test(line)) continue;
  const pid = line.trim().split(/\s+/).pop();
  if (pid && /^\d+$/.test(pid)) pids.add(pid);
}

if (pids.size === 0) {
  console.log(`Nothing listening on :${PORT}`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`Killing PID ${pid} (listening on :${PORT})`);
  execSync(`taskkill /F /PID ${pid}`, { stdio: "inherit" });
}
