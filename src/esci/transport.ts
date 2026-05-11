import type { SessionTransport } from "../scan-session.js";

const CLEAN_CLOSE_FALLBACK_MS = 5000;

/**
 * Polite-close gate for raw-TCP transports (legacy ESC/I path; issue #72).
 *
 * The engine's `settle()` unconditionally calls `transport.destroy()` as
 * its final cleanup step (see `scan-session.ts` settle comment). On a TLS
 * transport that's harmless after `end()` because `withEsci2UnlockOnDestroy`
 * already gates destroy on `politelyClosed`. On a bare raw socket there's
 * no such gate, so the engine's mandatory destroy can RST the connection
 * before the peer's FIN reaches us — Epson firmware has shown surprising
 * reactions to mid-handshake RSTs in prior bugs (panel-error class), so
 * the same gate belongs on the plain-TCP legacy path.
 *
 * Behaviour:
 *
 * 1. **`end()`**: flips `politelyClosed`, forwards to inner, starts a
 *    fallback timer that force-destroys if `close` never lands within
 *    {@link CLEAN_CLOSE_FALLBACK_MS}. Without the fallback a misbehaving
 *    peer could leak a socket per scan (the engine's post-DONE destroy
 *    being a no-op leaves it to TCP to drain — most printers send FIN
 *    promptly, but we don't want to rely on that for resource safety).
 *
 * 2. **`destroy()`**: no-op when `politelyClosed && !closed` (the engine's
 *    redundant post-DONE destroy). Forwards in every other case — true
 *    error path (no `end()` was reached) and the post-close cleanup path
 *    (close already fired, inner.destroy() is a no-op anyway).
 *
 * Sniffs the inner's `close` event so its own `closed` flag stays in
 * sync; the `close` callback passed to `on()` is still forwarded
 * unchanged, so the engine's close-handler sees identical semantics.
 */
export function withRawSocketCleanClose(inner: SessionTransport): SessionTransport {
  let politelyClosed = false;
  let closed = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFallback = () => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const wrapped: SessionTransport = {
    write(buf: Buffer) {
      return inner.write(buf);
    },
    end: (data?: Buffer) => {
      if (politelyClosed) {
        // Idempotent — engine should only call end() once, but guard
        // anyway so a double-call doesn't restart the fallback timer.
        return;
      }
      politelyClosed = true;
      inner.end(data);
      fallbackTimer = setTimeout(() => {
        if (!closed) inner.destroy();
      }, CLEAN_CLOSE_FALLBACK_MS);
      // .unref() so the fallback doesn't keep the daemon's event loop
      // alive past a clean shutdown.
      fallbackTimer.unref?.();
    },
    destroy(err?: Error) {
      if (politelyClosed && !closed) {
        // Engine's mandatory post-DONE destroy. No-op so the FIN we
        // just queued isn't pre-empted by a RST.
        return;
      }
      clearFallback();
      inner.destroy(err);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void) {
      if (event === "close") {
        inner.on("close", (hadError?: boolean) => {
          closed = true;
          clearFallback();
          (cb as (hadError?: boolean) => void)(hadError);
        });
      } else if (event === "data") {
        inner.on("data", cb as (chunk: Buffer) => void);
      } else if (event === "error") {
        inner.on("error", cb as (err: Error) => void);
      }
      return wrapped;
    },
  };
  return wrapped;
}
