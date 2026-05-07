import type tls from "node:tls";
import type { SessionTransport } from "../scan-session.js";
import { buildUnlockPacket } from "../protocol.js";

/**
 * Wraps a `tls.TLSSocket` into a `SessionTransport` with three protocol-
 * aware concerns the generic engine doesn't know about:
 *
 * 1. **Unlock on abort.** If the engine destroys the transport mid-session
 *    (after LOCK was sent but before the graph reached UNLOCKING),
 *    politely send the UNLOCK packet via `socket.end(unlock)` so the bytes
 *    actually leave the host before the socket closes — `socket.destroy()`
 *    can otherwise discard queued writes or send a TCP reset.
 *
 * 2. **TLS-error wrapping.** Bare ECONNRESET / EPIPE / etc. surfaces as
 *    "TLS connection error: <msg>" so operators (and tests) get a
 *    recognisable category.
 *
 * 3. **Suppress benign post-end errors.** Once the engine has called
 *    `transport.end()` (which only happens on entering DONE), the printer
 *    may still RST or EPIPE before its FIN reaches the host. Forwarding
 *    that to the engine would turn a successful scan into a rejection.
 *    The wrapper swallows those benign codes after end() has been called.
 *
 * Lives in its own module rather than in the scanner orchestration shell
 * so the protocol-aware close-timing logic doesn't bleed into either the
 * generic engine or the tiny shell. A future ESC/I-2-over-non-TLS
 * adapter (issue #43, ET-2750 hypothesis) gets a sibling factory in
 * scanner.ts and reuses this same wrapper unchanged.
 */
export function withEsci2UnlockOnDestroy(socket: tls.TLSSocket): SessionTransport {
  let unlockSent = false;
  let lockSent = false;
  // Tracks any teardown so post-close ECONNRESET / EPIPE noise can be
  // swallowed. Set by both end() and destroy().
  let endCalled = false;
  // Tracks specifically whether we already initiated a graceful close
  // via end(). The engine calls transport.destroy() from settle even on
  // healthy DONE (after end()), and a socket.destroy() there would RST
  // the connection mid-TLS-close_notify and cancel the FIN we politely
  // queued — reintroducing timing-dependent panel errors. When this is
  // true, destroy() is a no-op and the graceful close completes on its
  // own clock.
  let politelyClosed = false;
  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      // Track LOCK / UNLOCK sends by IS type byte (header byte 2-3).
      if (buf.length >= 4 && buf[2] === 0x21) {
        if (buf[3] === 0x00) lockSent = true;
        if (buf[3] === 0x01) unlockSent = true;
      }
      return socket.write(buf);
    },
    end: () => {
      endCalled = true;
      politelyClosed = true;
      socket.end();
    },
    destroy(err?: Error) {
      if (politelyClosed) return;
      endCalled = true;
      if (lockSent && !unlockSent) {
        // Mid-session error: send unlock then half-close, so the bytes
        // actually leave the host. Plain `write` + immediate `destroy`
        // can discard queued bytes or send TCP RST.
        try {
          socket.end(buildUnlockPacket());
        } catch {
          socket.destroy(err);
        }
      } else if (lockSent && unlockSent) {
        // Cleanup-state error after UNLOCK was already on the wire
        // (e.g., bad ack on the unlock reply, timeout in UNLOCKING,
        // async fatal during POSTSCAN drain). Application-layer
        // protocol close has happened — graceful TCP/TLS close
        // preserves close_notify timing, which the legacy scanner
        // relied on for panel hygiene.
        try {
          socket.end();
        } catch {
          socket.destroy(err);
        }
      } else {
        // Never locked — straight destroy is fine, no protocol state
        // to preserve.
        socket.destroy(err);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      if (event === "error") {
        socket.on(event, (err: Error & { code?: string }) => {
          // Suppress benign post-end resets so a printer that closes the
          // connection between our FIN and its FIN doesn't fail an
          // otherwise-successful scan. Mirrors the pre-engine scanner's
          // post-DONE error tolerance.
          if (endCalled && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
            return;
          }
          cb(new Error(`TLS connection error: ${err.message}`));
        });
      } else {
        socket.on(event, cb);
      }
      return wrapped;
    },
  };
  return wrapped;
}
