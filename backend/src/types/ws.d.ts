declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { ClientRequest, IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    constructor(address: string, options?: { headers?: Record<string, string> });
    send(data: string, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
    on(event: "pong", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: "open", listener: () => void): this;
    once(event: "close", listener: (code: number, reason: Buffer) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options: { noServer: true; maxPayload: number; perMessageDeflate: false });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: (error?: Error) => void): void;
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
}
