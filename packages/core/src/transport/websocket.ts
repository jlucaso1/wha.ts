import { bytesToHex } from "@wha.ts/utils";
import { IWebSocketClient } from "./types";

export class NativeWebSocketClient extends IWebSocketClient {
	private socket: WebSocket | null = null;
	private connectionPromise: {
		resolve: () => void;
		reject: (err: Error) => void;
	} | null = null;

	get isOpen(): boolean {
		return this.socket?.readyState === this.socket?.OPEN;
	}
	get isClosed(): boolean {
		return !this.socket || this.socket.readyState === this.socket?.CLOSED;
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === this.socket?.CONNECTING;
	}
	get isClosing(): boolean {
		return this.socket?.readyState === this.socket?.CLOSING;
	}

	connect(): Promise<void> {
		if (this.socket && this.socket.readyState !== this.socket?.CLOSED) {
			this.config.logger.warn({}, "WebSocket already connecting or open");
			if (this.isConnecting && this.connectionPromise) {
				return new Promise((res, rej) => {
					this.addEventListener("open", () => res(), { once: true });
					this.addEventListener("error", (err) => rej(err), { once: true });
					this.addEventListener(
						"close",
						() => rej(new Error("WebSocket closed during connection attempt")),
						{ once: true },
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

		try {
			this.socket?.send(data);
			this.dispatchTypedEvent("sent", { data });
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
			this.addEventListener("close", () => resolve(), { once: true });
			this.socket?.close(code, reason);
		});
	}

	private handleOpen = (): void => {
		this.connectionPromise?.resolve();
		this.connectionPromise = null;
		this.dispatchTypedEvent("open", null);
	};

	private handleMessage = (event: MessageEvent<ArrayBuffer>): void => {
		const data = new Uint8Array(event.data);

		this.dispatchTypedEvent("received", { data });
	};

	private handleError = (): void => {
		const error = new Error("WebSocket error event");
		this.config.logger.error({ err: error }, "WebSocket error");
		this.connectionPromise?.reject(error);
		this.connectionPromise = null;
		this.dispatchTypedEvent("error", error);
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
		this.dispatchTypedEvent("close", { code, reason });
	};

	private removeListeners(): void {
		if (!this.socket) return;
		this.socket.removeEventListener("open", this.handleOpen);
		this.socket.removeEventListener("message", this.handleMessage);
		this.socket.removeEventListener("error", this.handleError);
		this.socket.removeEventListener("close", this.handleClose);
	}
}
