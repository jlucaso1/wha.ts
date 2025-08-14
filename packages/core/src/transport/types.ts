import { TypedEventTarget } from "@wha.ts/types/generics/typed-event-target";
import type { ILogger } from "@wha.ts/types/transport";

export interface WebSocketClientEventMap {
	open: null;
	received: { data: Uint8Array };
	error: Error;
	close: { code: number; reason: string };
	sent: { data: Uint8Array };
}

export interface WebSocketConfig {
	url: URL;
	connectTimeoutMs: number;
	logger: ILogger;
	origin?: string;
	headers?: { [key: string]: string };
}

export abstract class IWebSocketClient extends TypedEventTarget<WebSocketClientEventMap> {
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
