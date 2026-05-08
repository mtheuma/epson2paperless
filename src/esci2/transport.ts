import type { SessionTransport } from "../scan-session.js";
import { buildUnlockPacket } from "../protocol.js";

/**
 * Adds TLS-flavoured error handling on top of any `SessionTransport`:
 *
 * 1. **Mid-session error labelling.** Bare `ECONNRESET` / `EPIPE` / etc on
 *    the inner transport surfaces to the engine as
 *    `"TLS connection error: <msg>"` so operators (and tests) get a
 *    recognisable category. Handshake errors are caught by the factory's
 *    `socket.once("error", reject)` and never reach this wrapper, so the
 *    label only ever appears mid-session.
 *
 * 2. **Suppress benign post-`end()` resets.** Once `end()` has been called
 *    (engine entered DONE), the printer may still RST or EPIPE before its
 *    FIN reaches the host. Forwarding that would turn a successful scan
 *    into a rejection. The wrapper swallows those benign codes after
 *    `end()` has been called.
 *
 * Composes inside `withEsci2UnlockOnDestroy`; the outer unlock wrapper
 * coordinates destroy semantics, this layer just tracks whether `end()`
 * was reached so the post-end RST swallow is correct.
 */
export function withTlsErrorLabels(inner: SessionTransport): SessionTransport {
  let endCalled = false;
  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      return inner.write(buf);
    },
    end: (data?: Buffer) => {
      endCalled = true;
      inner.end(data);
    },
    destroy(err?: Error) {
      inner.destroy(err);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      if (event === "error") {
        inner.on("error", (err: Error & { code?: string }) => {
          if (endCalled && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
            return;
          }
          cb(new Error(`TLS connection error: ${err.message}`));
        });
      } else if (event === "data") {
        inner.on("data", cb as (chunk: Buffer) => void);
      } else if (event === "close") {
        inner.on("close", cb as (hadError?: boolean) => void);
      }
      return wrapped;
    },
  };
  return wrapped;
}

/**
 * Wraps any `SessionTransport` (TLS or plain TCP) with ESC/I-2-protocol-
 * aware destroy-time semantics:
 *
 * 1. **Track LOCK / UNLOCK on the wire.** Sniffs writes by IS type byte
 *    (header bytes 2-3): `0x21 0x00` = LOCK, `0x21 0x01` = UNLOCK.
 *
 * 2. **Unlock-on-abort.** If the engine destroys the transport mid-session
 *    (after LOCK was sent but before UNLOCK), politely send the UNLOCK
 *    packet via `inner.end(unlock)` so the bytes leave before the socket
 *    closes — a bare `destroy()` could discard queued writes or send a
 *    TCP reset.
 *
 * 3. **Polite-close gate.** When `end()` has already been called (engine
 *    reached DONE), a follow-up `destroy()` is a no-op so it doesn't RST
 *    the connection mid-TLS-`close_notify` and cancel the FIN we politely
 *    queued. The engine's `settle()` always calls `destroy()`; this gate
 *    is what makes that contract safe.
 *
 * Transport-blind: works equally well over TLS (composed with
 * `withTlsErrorLabels`) and plain TCP (composed alone). The optional
 * `data` argument on `inner.end()` is the reason `SessionTransport.end`
 * accepts a buffer — `inner.end(buildUnlockPacket())` flows the bytes
 * through the lower layer's flush before the FIN.
 */
export function withEsci2UnlockOnDestroy(inner: SessionTransport): SessionTransport {
  let unlockSent = false;
  let lockSent = false;
  let politelyClosed = false;
  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      // Track LOCK / UNLOCK sends by IS type byte (header bytes 2-3).
      if (buf.length >= 4 && buf[2] === 0x21) {
        if (buf[3] === 0x00) lockSent = true;
        if (buf[3] === 0x01) unlockSent = true;
      }
      return inner.write(buf);
    },
    end: (data?: Buffer) => {
      politelyClosed = true;
      inner.end(data);
    },
    destroy(err?: Error) {
      if (politelyClosed) return;
      if (lockSent && !unlockSent) {
        // Mid-session error: send UNLOCK then half-close, so the bytes
        // actually leave the host. Plain `write` + immediate `destroy`
        // can discard queued bytes or send TCP RST.
        try {
          inner.end(buildUnlockPacket());
        } catch {
          inner.destroy(err);
        }
      } else if (lockSent && unlockSent) {
        // Cleanup-state error after UNLOCK was already on the wire
        // (e.g., bad ack on the unlock reply, timeout in UNLOCKING,
        // async fatal during POSTSCAN drain). Application-layer
        // protocol close has happened — graceful TCP/TLS close
        // preserves close_notify timing, which the legacy scanner
        // relied on for panel hygiene.
        try {
          inner.end();
        } catch {
          inner.destroy(err);
        }
      } else {
        // Never locked — straight destroy is fine, no protocol state
        // to preserve.
        inner.destroy(err);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      // SessionTransport.on is overloaded per event; dispatch by event so
      // each branch hits the matching overload signature.
      if (event === "data") {
        inner.on("data", cb as (chunk: Buffer) => void);
      } else if (event === "error") {
        inner.on("error", cb as (err: Error) => void);
      } else if (event === "close") {
        inner.on("close", cb as (hadError?: boolean) => void);
      }
      return wrapped;
    },
  };
  return wrapped;
}
