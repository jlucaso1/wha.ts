import { Buffer } from "node:buffer";
import { WebSocket } from "ws";
import type { URL } from "node:url";
import { IWebSocketClient, type WebSocketConfig } from "./types";
import { DEFAULT_ORIGIN } from "../defaults";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class NativeWebSocketClient extends IWebSocketClient {
  private socket: WebSocket | null = null;
  private connectionPromise: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(url: URL, config: WebSocketConfig) {
    super(url, config);
  }

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }
  get isClosed(): boolean {
    return !this.socket || this.socket.readyState === CLOSED;
  }
  get isConnecting(): boolean {
    return this.socket?.readyState === CONNECTING;
  }
  get isClosing(): boolean {
    return this.socket?.readyState === CLOSING;
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState !== CLOSED) {
      this.config.logger.warn({}, "WebSocket already connecting or open");
      return this.isConnecting
        ? new Promise((res, rej) => {
            if (this.connectionPromise) {
              const originalResolve = this.connectionPromise.resolve;
              const originalReject = this.connectionPromise.reject;
              this.connectionPromise.resolve = () => {
                originalResolve();
                res();
              };
              this.connectionPromise.reject = (err) => {
                originalReject(err);
                rej(err);
              };
            } else {
              this.once("open", res);
              this.once("error", rej);
              this.once("close", () =>
                rej(new Error("WebSocket closed during connection attempt"))
              );
            }
          })
        : Promise.resolve();
    }
    this.config.logger.info(
      { url: this.url.toString() },
      "Connecting WebSocket"
    );

    return new Promise<void>((resolve, reject) => {
      this.connectionPromise = { resolve, reject };

      try {
        this.socket = new WebSocket(this.url.toString(), {
          origin: this.config.origin || DEFAULT_ORIGIN,
          headers: this.config.headers,
          handshakeTimeout: this.config.connectTimeoutMs,
          agent: this.config.agent,
        });

        this.socket.setMaxListeners(0);

        this.socket.on("open", this.handleOpen);
        this.socket.on("message", this.handleMessage);
        this.socket.on("error", this.handleError);
        this.socket.on("close", this.handleClose);
        this.socket.on("unexpected-response", this.handleUnexpectedResponse);
      } catch (error: any) {
        this.config.logger.error(
          { err: error },
          "WebSocket instantiation failed"
        );
        this.connectionPromise?.reject(error);
        this.connectionPromise = null;
      }
    });
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.isOpen) {
      this.config.logger.error({}, "WebSocket not open, cannot send");
      throw new Error("WebSocket is not open");
    }
    this.config.logger.debug(
      { length: data.length },
      "Sending WebSocket message"
    );
    return new Promise((resolve, reject) => {
      this.socket?.send(data, (error) => {
        if (error) {
          this.config.logger.error({ err: error }, "WebSocket send error");
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(
    code: number = 1000,
    reason: string = "Normal Closure"
  ): Promise<void> {
    if (this.isClosing || this.isClosed) {
      this.config.logger.warn(
        { state: this.socket?.readyState },
        "WebSocket already closing or closed"
      );
      return Promise.resolve();
    }

    this.config.logger.info({ code, reason }, "Closing WebSocket");
    return new Promise((resolve) => {
      this.once("close", resolve);
      this.socket?.close(code, reason);
    });
  }

  private handleOpen = (): void => {
    this.config.logger.info({}, "WebSocket opened");
    this.connectionPromise?.resolve();
    this.connectionPromise = null;
    this.emit("open");
  };

  private handleMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
    let bufferData: Buffer;
    if (Buffer.isBuffer(data)) {
      bufferData = data;
    } else if (data instanceof ArrayBuffer) {
      bufferData = Buffer.from(data);
    } else if (Array.isArray(data)) {
      bufferData = Buffer.concat(data);
    } else {
      this.config.logger.warn(
        { type: typeof data },
        "Received unexpected message type"
      );
      return;
    }
    this.emit("message", bufferData);
  };

  private handleError = (error: Error): void => {
    this.config.logger.error({ err: error }, "WebSocket error");
    this.connectionPromise?.reject(error);
    this.connectionPromise = null;
    this.emit("error", error);
  };

  private handleClose = (code: number, reason: Buffer): void => {
    const reasonString = reason.toString();
    this.config.logger.info({ code, reason: reasonString }, "WebSocket closed");
    const error = this.connectionPromise
      ? new Error(`WebSocket closed before opening: ${code} ${reasonString}`)
      : undefined;
    this.connectionPromise?.reject(
      error || new Error(`WebSocket closed: ${code} ${reasonString}`)
    );
    this.connectionPromise = null;
    this.removeListeners();
    this.socket = null;
    this.emit("close", code, reasonString);
  };

  private handleUnexpectedResponse = (req: any, res: any): void => {
    const error = new Error(`Unexpected server response: ${res.statusCode}`);
    this.config.logger.error(
      { status: res.statusCode, headers: res.headers },
      "WebSocket unexpected response"
    );
    this.connectionPromise?.reject(error);
    this.connectionPromise = null;
    this.emit("error", error);
  };

  private removeListeners(): void {
    this.socket?.off("open", this.handleOpen);
    this.socket?.off("message", this.handleMessage);
    this.socket?.off("error", this.handleError);
    this.socket?.off("close", this.handleClose);
    this.socket?.off("unexpected-response", this.handleUnexpectedResponse);
  }

  private closeWithError(error: Error): void {
    if (!this.isClosed && !this.isClosing) {
      this.socket?.terminate();
    }
    this.removeListeners();
    this.socket = null;
    this.emit("error", error);
    this.emit("close", 1011, "Internal Error");
  }
}
