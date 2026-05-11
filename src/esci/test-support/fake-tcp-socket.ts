import type * as net from "node:net";
import { FakeSocketBase } from "../../test-support/fake-socket-base.js";

/**
 * Minimal `net.Socket`-shaped fake driving the ESC/I scanner in tests.
 * Inherits buffering for `data` / `error` events from FakeSocketBase.
 */
export class FakeTcpSocket extends FakeSocketBase {
  private onConnect?: () => void;

  setOnConnect(cb?: () => void): void {
    this.onConnect = cb;
  }

  simulateConnect(): void {
    this.onConnect?.();
  }

  end(): void {
    this.emit("close");
  }

  destroy(): void {
    this.emit("close");
  }

  asFactory(): (host: string, port: number, cb?: () => void) => net.Socket {
    return (_host, _port, cb) => {
      this.setOnConnect(cb);
      return this as unknown as net.Socket;
    };
  }
}
