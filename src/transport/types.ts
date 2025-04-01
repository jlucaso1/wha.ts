import type { Agent } from "node:https";
import EventEmitter from "node:events";
import type { URL } from "node:url";

export interface ILogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
  // level: string;
}

export interface WebSocketConfig {
  url: URL;
  connectTimeoutMs: number;
  logger: ILogger;
  agent?: Agent;
  origin?: string;
  headers?: { [key: string]: string };
  keepAliveIntervalMs?: number;
}

export abstract class IWebSocketClient extends EventEmitter {
  abstract get isOpen(): boolean;
  abstract get isClosed(): boolean;
  abstract get isConnecting(): boolean;
  abstract get isClosing(): boolean;

  constructor(public url: URL, public config: WebSocketConfig) {
    super();
    this.setMaxListeners(0);
  }

  abstract connect(): Promise<void>;
  abstract send(data: Uint8Array): Promise<void>;
  abstract close(code?: number, reason?: string): Promise<void>;
}
