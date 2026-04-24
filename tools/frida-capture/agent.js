// Frida agent for ES2Command.dll IS-packet capture.
// Target: es2projectrunner.exe (32-bit, Windows x86 __thiscall ABI).
//
// Hook targets (derived from Ghidra analysis of ES2Command.dll):
//
// Original plan targeted CISProtocolStream::{Send,Receive}ISPacket + DidReceiveAsyncEvent,
// but Ghidra showed those functions have no clean (buffer, size) stack args — they build
// packets internally via stream state and vtable calls. Pivoted to the TLS-level helpers
// they delegate to:
//
//   FUN_100a7fa0 at 0xa7fa0 — TLS write
//     Signature: byte __thiscall(void* this, int buffer, int len)
//     args[0] = buffer pointer (fully-assembled IS packet)
//     args[1] = buffer length
//     Capture onEnter: buffer is populated before the TLS write.
//
//   FUN_100a7db0 at 0xa7db0 — TLS read
//     Signature: undefined4 __thiscall(void* this, int buffer, uint len)
//     args[0] = buffer pointer (filled by callee)
//     args[1] = buffer length
//     Capture onLeave: buffer written during the call.
//     NOTE: Called twice per received IS packet with a non-empty body — first with
//     len=12 for the IS header, then again with len=<body size> for the body. Each
//     call emits one recv record; pretty-print treats them individually.
//
// Async events (scan start, ServerError, etc.) arrive over the recv stream as IS
// packets of type 0x9000 with the event code as the first byte of the IS body.
// We do NOT hook DidReceiveAsyncEvent separately — it uses EAX (not ECX) for `this`
// and fetches the event code via vtable, both of which make a clean Frida capture
// awkward. The recv hook captures the same information.

// Frida 17 removed the legacy `Module.findBaseAddress()` free function.
// Use `Process.findModuleByName(...)?.base` instead.
const MODULE_NAME = "ES2Command.dll";

let hooksInstalled = false;

function installHooks(baseAddr) {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const SEND_ADDR = baseAddr.add(0xa7fa0);
  const RECV_ADDR = baseAddr.add(0xa7db0);

  send({
    hook: "startup",
    module_base: baseAddr.toString(),
    send_addr: SEND_ADDR.toString(),
    recv_addr: RECV_ADDR.toString(),
  });

  Interceptor.attach(SEND_ADDR, SEND_CALLBACKS);
  Interceptor.attach(RECV_ADDR, RECV_CALLBACKS);
}

function bytesToHex(buf) {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

function typeFromPacketHeader(packetPtr, packetLen) {
  // IS header: "IS" magic (2 bytes) + type (uint16 big-endian).
  // Only meaningful when the buffer actually starts with a 12-byte IS header
  // (i.e. send records, or the header-phase of a recv pair).
  if (packetLen < 4) return "0x0000";
  const b0 = packetPtr.add(2).readU8();
  const b1 = packetPtr.add(3).readU8();
  const t = (b0 << 8) | b1;
  return "0x" + t.toString(16).padStart(4, "0");
}

function looksLikeIsHeader(packetPtr, packetLen) {
  // A buffer "looks like" an IS header if it's at least 12 bytes and starts with "IS".
  if (packetLen < 12) return false;
  return packetPtr.readU8() === 0x49 /* 'I' */ && packetPtr.add(1).readU8() === 0x53 /* 'S' */;
}

function sendError(hook, err) {
  try {
    send({ hook: "error", msg: `${hook}: ${err && err.message ? err.message : String(err)}` });
  } catch (_) {
    // If even send() fails, nothing we can do.
  }
}

const SEND_CALLBACKS = {
  onEnter(args) {
    try {
      const packetPtr = args[0];
      const packetLen = args[1].toInt32();
      const bytes = packetPtr.readByteArray(packetLen);
      send({
        hook: "send",
        type_hex: typeFromPacketHeader(packetPtr, packetLen),
        payload_hex: bytesToHex(bytes),
        payload_size: packetLen,
      });
    } catch (err) {
      sendError("send", err);
    }
  },
};

const RECV_CALLBACKS = {
  onEnter(args) {
    // Save buffer pointer + length so onLeave can read them after the callee fills the buffer.
    this.bufPtr = args[0];
    this.bufLen = args[1].toInt32();
  },
  onLeave(_retval) {
    try {
      const bytes = this.bufPtr.readByteArray(this.bufLen);
      const isHeader = looksLikeIsHeader(this.bufPtr, this.bufLen);
      send({
        hook: "recv",
        // type_hex only meaningful for header-phase recvs; body-phase recvs have
        // "0x0000" since the bytes aren't an IS header.
        type_hex: isHeader ? typeFromPacketHeader(this.bufPtr, this.bufLen) : "0x0000",
        payload_hex: bytesToHex(bytes),
        payload_size: this.bufLen,
      });
    } catch (err) {
      sendError("recv", err);
    }
  },
};

// Bootstrap — runs last so installHooks's references to SEND_CALLBACKS /
// RECV_CALLBACKS are already resolved. If the DLL is loaded now, hook
// immediately (attach-to-running flow). Otherwise watch for it to load
// (child-gated spawn flow, where the DLL doesn't exist yet at attach time).
const existing = Process.findModuleByName(MODULE_NAME);
if (existing) {
  installHooks(existing.base);
} else {
  send({ hook: "waiting", msg: `${MODULE_NAME} not loaded yet; will hook on load` });
  Process.attachModuleObserver({
    onAdded(module) {
      if (module.name.toLowerCase() === MODULE_NAME.toLowerCase()) {
        installHooks(module.base);
      }
    },
    onRemoved(_module) {},
  });
}
