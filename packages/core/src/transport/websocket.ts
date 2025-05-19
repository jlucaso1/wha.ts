import { bytesToHex } from "@wha.ts/utils/src/bytes-utils";
import { IWebSocketClient } from "./types";

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

	once(eventName: string, listener: (...args: unknown[]) => void) {
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
			if (this.isConnecting && this.connectionPromise) {
				// Always return the same promise if already connecting
				return new Promise((res, rej) => {
					this.once("open", () => res());
					this.once("error", (err) => rej(err));
					this.once("close", () =>
						rej(new Error("WebSocket closed during connection attempt")),
					);
				});
			}
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			this.connectionPromise = { resolve, reject };

			try {
				this.socket = new WebSocket(this.url.toString());

				this.socket.binaryType = "arraybuffer";

				this.socket.addEventListener("open", this.handleOpen);
				this.socket.addEventListener("message", this.handleMessage);
				this.socket.addEventListener("error", this.handleError);
				this.socket.addEventListener("close", this.handleClose);
			} catch (error) {
				this.config.logger.error(
					{ err: error },
					"WebSocket instantiation failed",
				);
				this.connectionPromise?.reject(error as Error);
				this.connectionPromise = null;
			}
		});
	}

	async send(data: Uint8Array): Promise<void> {
		if (!this.isOpen) {
			this.config.logger.warn(
				{
					data: bytesToHex(data),
				},
				"WebSocket not open, cannot send",
			);
			return;
		}

		this.dispatchEvent(
			new CustomEvent("debug:websocket:sending_raw", {
				detail: { data },
			}),
		);

		try {
			this.socket?.send(data);
		} catch (error) {
			this.config.logger.error({ err: error }, "WebSocket send error");
			throw error;
		}
	}

	async close(code = 1000, reason = "Normal Closure"): Promise<void> {
		if (this.isClosing || this.isClosed) {
			this.config.logger.warn(
				{ state: this.socket?.readyState },
				"WebSocket already closing or closed",
			);
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			this.once("close", () => resolve());
			this.socket?.close(code, reason);
		});
	}

	private handleOpen = (): void => {
		this.connectionPromise?.resolve();
		this.connectionPromise = null;
		this.dispatchEvent(new CustomEvent("open"));
	};

	private handleMessage = (event: MessageEvent<ArrayBuffer>): void => {
		const data = new Uint8Array(event.data);

		this.dispatchEvent(
			new CustomEvent("debug:websocket:received_raw", {
				detail: { data: new Uint8Array(data) },
			}),
		);

		this.dispatchEvent(new CustomEvent("message", { detail: data }));
	};

	private handleError = (): void => {
		const error = new Error("WebSocket error event");
		this.config.logger.error({ err: error }, "WebSocket error");
		this.connectionPromise?.reject(error);
		this.connectionPromise = null;
		this.dispatchEvent(new CustomEvent("error", { detail: error }));
	};

	private handleClose = (event: CloseEvent): void => {
		const { code, reason } = event;
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
}

Object.setPrototypeOf(NativeWebSocketClient.prototype, EventTarget.prototype);
