#!/usr/bin/env python3
"""
Frida host for ES2Command.dll IS-packet capture.

Polls for the target process, attaches when it appears, loads agent.js,
and streams messages to a timestamped JSONL file.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import frida  # type: ignore[import-untyped]


DEFAULT_TARGET = "es2projectrunner.exe"
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "captures"
POLL_INTERVAL_S = 0.05  # 50 ms — see spec for rationale
AGENT_PATH = Path(__file__).parent / "agent.js"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=DEFAULT_TARGET,
                        help=f"Process name to attach to (default: {DEFAULT_TARGET})")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR,
                        help=f"Directory for JSONL capture files (default: {DEFAULT_OUTPUT_DIR})")
    parser.add_argument("--label", default="",
                        help="Optional label appended to the capture filename")
    parser.add_argument(
        "--child-gate",
        action="store_true",
        help=(
            "Attach to the parent process (default: EEventManager.exe), enable "
            "child gating, and follow the spawn chain until we catch the target "
            "before its first instruction. Useful for catching WELCOME / LOCK "
            "packets that an attach-after-running miss. Requires the parent "
            "process to already be running and this host.py to have permission "
            "to attach to it."
        ),
    )
    parser.add_argument(
        "--parent",
        default="EEventManager.exe",
        help=(
            "Parent process name for --child-gate mode. Defaults to "
            "EEventManager.exe, which is the long-lived Epson service that "
            "launches the scan process chain."
        ),
    )
    return parser.parse_args()


def open_capture_file(output_dir: Path, label: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    suffix = f"-{label}" if label else ""
    path = output_dir / f"{now}{suffix}.jsonl"
    print(f"[host] writing capture to {path}", file=sys.stderr)
    return path, open(path, "w", encoding="utf-8")


def wait_for_target(device, target: str):
    """Block until a process matching `target` appears, then return its PID."""
    print(f"[host] polling for {target}…", file=sys.stderr)
    while True:
        for proc in device.enumerate_processes():
            if proc.name.lower() == target.lower():
                return proc.pid
        time.sleep(POLL_INTERVAL_S)


def _child_basename(child) -> str:
    """Return the lowercased filename of a Frida Child.

    Frida's Child object has several fields that might carry the executable
    info (`path`, `identifier`, sometimes `argv[0]`); Windows populates `path`
    while other platforms may use `identifier`. Fall through them.
    """
    candidates = []
    for attr in ("path", "identifier"):
        val = getattr(child, attr, None)
        if val:
            candidates.append(val)
    argv = getattr(child, "argv", None)
    if argv:
        candidates.append(argv[0])
    for raw in candidates:
        name = str(raw).lower()
        base = name.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        if base:
            return base
    return ""


def wait_for_target_via_child_gate(device, target: str, parent_name: str):
    """Attach to `parent_name`, enable child gating, and follow the spawn chain
    until `target` appears as a (recursively) gated child. Returns a tuple of
    (target_pid, list_of_helper_sessions_to_detach_later).

    Frida on Windows supports session.enable_child_gating() but NOT
    device.enable_spawn_gating(). Child gating follows children spawned by
    an already-attached process — so we attach to the long-lived parent
    (EEventManager.exe by default), then recursively attach + gate each
    intermediate child as the spawn chain plays out, until we reach target.
    """
    # Find the parent process
    parent_pid = None
    for proc in device.enumerate_processes():
        if proc.name.lower() == parent_name.lower():
            parent_pid = proc.pid
            break
    if parent_pid is None:
        raise RuntimeError(
            f"{parent_name} not running — start it first, then retry."
        )

    print(f"[host] attaching to parent {parent_name} (PID {parent_pid})", file=sys.stderr)
    parent_session = device.attach(parent_pid)
    parent_session.enable_child_gating()

    helper_sessions: list = [parent_session]
    matched: dict = {"pid": None}
    target_lower = target.lower()

    def on_child_added(child):
        base = _child_basename(child)
        print(
            f"[host] child spawned: pid={child.pid}, name={base or '<unknown>'}, "
            f"path={getattr(child, 'path', None)!r}, identifier={getattr(child, 'identifier', None)!r}",
            file=sys.stderr,
        )

        if base == target_lower:
            # Found it — leave suspended so main() attaches, loads the agent, then resumes.
            matched["pid"] = child.pid
            return

        # Intermediate process — attach + gate + resume so its own children are visible.
        try:
            cs = device.attach(child.pid)
            cs.enable_child_gating()
            helper_sessions.append(cs)
            device.resume(child.pid)
            print(f"[host] intermediate child gated + resumed: {base}", file=sys.stderr)
        except Exception as e:
            print(f"[host] failed to gate intermediate child {base}: {e}", file=sys.stderr)
            try:
                device.resume(child.pid)
            except Exception:
                pass

    # The `child-added` signal is device-level; session.enable_child_gating()
    # is what routes the session's children through that signal.
    device.on("child-added", on_child_added)

    print(
        f"[host] child gating enabled on {parent_name} — trigger the scan "
        f"now to spawn {target}…",
        file=sys.stderr,
    )
    while matched["pid"] is None:
        time.sleep(POLL_INTERVAL_S)

    return matched["pid"], helper_sessions


def main() -> int:
    args = parse_args()
    capture_path, jsonl_fh = open_capture_file(args.output_dir, args.label)

    if not AGENT_PATH.exists():
        print(f"[host] agent not found at {AGENT_PATH}", file=sys.stderr)
        return 1

    agent_source = AGENT_PATH.read_text(encoding="utf-8")

    device = frida.get_local_device()
    helper_sessions: list = []
    if args.child_gate:
        pid, helper_sessions = wait_for_target_via_child_gate(
            device, args.target, args.parent
        )
    else:
        pid = wait_for_target(device, args.target)
    print(f"[host] attaching to PID {pid}", file=sys.stderr)
    session = device.attach(pid)

    def on_message(message, _data):
        if message["type"] == "send":
            record = message["payload"]
            record["ts"] = datetime.now(timezone.utc).isoformat()
            jsonl_fh.write(json.dumps(record) + "\n")
            jsonl_fh.flush()
            hook = record.get("hook", "?")
            if hook in ("send", "recv", "async_event"):
                print(f"[host] {hook} type={record.get('type_hex')} size={record.get('payload_size')}", file=sys.stderr)
            elif hook == "startup":
                print(f"[host] agent loaded; module_base={record.get('module_base')}", file=sys.stderr)
            elif hook == "waiting":
                print(f"[host] agent waiting: {record.get('msg')}", file=sys.stderr)
            elif hook == "error":
                print(f"[host] agent error: {record.get('msg')}", file=sys.stderr)
        elif message["type"] == "error":
            print(f"[host] frida error: {message.get('description')}", file=sys.stderr)

    script = session.create_script(agent_source)
    script.on("message", on_message)
    script.load()
    print("[host] capturing — press Ctrl+C to stop", file=sys.stderr)
    if args.child_gate:
        try:
            device.resume(pid)
            print(f"[host] resumed target PID {pid}", file=sys.stderr)
        except Exception as e:
            print(f"[host] resume failed: {e}", file=sys.stderr)

    try:
        # Stay alive until the target process exits or the user interrupts.
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("[host] interrupted; closing capture", file=sys.stderr)
    except frida.ProcessNotFoundError:
        print("[host] target process exited; closing capture", file=sys.stderr)
    finally:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass
        for helper in helper_sessions:
            try:
                helper.detach()
            except Exception:
                pass
        jsonl_fh.close()
        print(f"[host] capture saved to {capture_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
