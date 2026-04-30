import { EventEmitter } from "node:events";
import type * as net from "node:net";

export class FakeTcpSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  private onConnect?: () => void;

  setOnConnect(cb?: () => void): void {
    this.onConnect = cb;
  }

  simulateConnect(): void {
    this.onConnect?.();
  }

  feed(chunk: Buffer): void {
    this.emit("data", chunk);
  }

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
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
