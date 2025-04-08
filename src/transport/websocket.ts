import { IWebSocketClient, type WebSocketConfig } from "./types";

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

  once(eventName: string, listener: (...args: any[]) => void) {
    const handler = (event: Event | CustomEvent) => {
      if (event instanceof CustomEvent) {
        listener(event.detail);
      } else {
        listener(event);
      }
    };
    this.addEventListener(eventName, handler, { once: true });
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
              rej(new Error("WebSocket closed during connection attempt")));
          }
        })
        : Promise.resolve();
    }

    this.config.logger.info(
      { url: this.url.toString() },
      "Connecting WebSocket",
    );

    return new Promise<void>((resolve, reject) => {
      this.connectionPromise = { resolve, reject };

      try {
        this.socket = new WebSocket(this.url.toString());

        this.socket.binaryType = "arraybuffer";

        this.socket.addEventListener("open", this.handleOpen);
        this.socket.addEventListener("message", this.handleMessage);
        this.socket.addEventListener("error", this.handleError);
        this.socket.addEventListener("close", this.handleClose);
      } catch (error: any) {
        this.config.logger.error(
          { err: error },
          "WebSocket instantiation failed",
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

    try {
      this.socket!.send(data);
    } catch (error: any) {
      this.config.logger.error({ err: error }, "WebSocket send error");
      throw error;
    }
  }

  async close(
    code: number = 1000,
    reason: string = "Normal Closure",
  ): Promise<void> {
    if (this.isClosing || this.isClosed) {
      this.config.logger.warn(
        { state: this.socket?.readyState },
        "WebSocket already closing or closed",
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
    this.dispatchEvent(new CustomEvent("open"));
  };

  private handleMessage = (event: MessageEvent): void => {
    const data = event.data;
    let bufferData: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bufferData = new Uint8Array(data);
    } else if (typeof data === "string") {
      bufferData = new TextEncoder().encode(data);
    } else {
      this.config.logger.warn(
        { type: typeof data },
        "Received unexpected message type",
      );
      return;
    }
    this.dispatchEvent(new CustomEvent("message", { detail: bufferData }));
  };

  private handleError = (_event: Event): void => {
    const error = new Error("WebSocket error event");
    this.config.logger.error({ err: error }, "WebSocket error");
    this.connectionPromise?.reject(error);
    this.connectionPromise = null;
    this.dispatchEvent(new CustomEvent("error", { detail: error }));
  };

  private handleClose = (event: any): void => {
    const { code, reason } = event;
    this.config.logger.info({ code, reason }, "WebSocket closed");
    const error = this.connectionPromise
      ? new Error(`WebSocket closed before opening: ${code} ${reason}`)
      : undefined;
    this.connectionPromise?.reject(
      error || new Error(`WebSocket closed: ${code} ${reason}`),
    );
    this.connectionPromise = null;
    this.removeListeners();
    this.socket = null;
    this.dispatchEvent(new CustomEvent("close", { detail: { code, reason } }));
  };

  private removeListeners(): void {
    if (!this.socket) return;
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
  }

  private closeWithError(error: Error): void {
    if (!this.isClosed && !this.isClosing) {
      this.socket?.close(1011, "Internal Error");
    }
    this.removeListeners();
    this.socket = null;
    this.dispatchEvent(new CustomEvent("error", { detail: error }));
    this.dispatchEvent(new CustomEvent("close", { detail: { code: 1011, reason: "Internal Error" } }));
  }
}

Object.setPrototypeOf(NativeWebSocketClient.prototype, EventTarget.prototype);
