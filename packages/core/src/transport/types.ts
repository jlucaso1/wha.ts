export interface ILogger {
	info(obj: unknown, msg?: string): void;
	error(obj: unknown, msg?: string): void;
	warn(obj: unknown, msg?: string): void;
	debug(obj: unknown, msg?: string): void;
	trace(obj: unknown, msg?: string): void;
}

export interface WebSocketConfig {
	url: URL;
	connectTimeoutMs: number;
	logger: ILogger;
	origin?: string;
	headers?: { [key: string]: string };
}

export abstract class IWebSocketClient extends EventTarget {
	abstract get isOpen(): boolean;
	abstract get isClosed(): boolean;
	abstract get isConnecting(): boolean;
	abstract get isClosing(): boolean;

	constructor(
		public url: URL,
		public config: WebSocketConfig,
	) {
		super();
	}

	abstract connect(): Promise<void>;
	abstract send(data: Uint8Array): Promise<void>;
	abstract close(code?: number, reason?: string): Promise<void>;
}
