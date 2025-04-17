import type { ClientEventMap } from "./client-events";
import { Authenticator } from "./core/authenticator";
import type {
	ConnectionUpdatePayload,
	CredsUpdatePayload,
} from "./core/authenticator-events";
import { ConnectionManager } from "./core/connection";
import type { IConnectionActions } from "./core/types";
import { DEFAULT_BROWSER, DEFAULT_SOCKET_CONFIG, WA_VERSION } from "./defaults";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "./generics/typed-event-target";
import { MessageProcessor } from "./messaging/message-processor";
import type {
	AuthenticationCreds,
	IAuthStateProvider,
} from "./state/interface";
import type { ILogger, WebSocketConfig } from "./transport/types";

interface ClientConfig {
	auth: IAuthStateProvider;
	logger?: ILogger;
	wsOptions?: Partial<WebSocketConfig>;
	version?: number[];
	browser?: readonly [string, string, string];
}

declare interface WhaTSClient {
	ws: ConnectionManager["ws"];
	auth: IAuthStateProvider;
	logger: ILogger;

	connect(): Promise<void>;
	logout(reason?: string): Promise<void>;

	addListener<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void;
}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: solve later
class WhaTSClient extends TypedEventTarget<ClientEventMap> {
	private config: Required<Omit<ClientConfig, "logger">> & { logger: ILogger };
	private messageProcessor: MessageProcessor;
	private conn: ConnectionManager;
	private authenticator: Authenticator;

	constructor(config: ClientConfig) {
		super();

		const logger = config.logger || (console as ILogger);

		this.config = {
			auth: config.auth,
			logger: logger,
			version: config.version || WA_VERSION,
			browser: config.browser || DEFAULT_BROWSER,
			wsOptions: {
				...DEFAULT_SOCKET_CONFIG,
				...(config.wsOptions || {}),
				url: new URL(
					config.wsOptions?.url?.toString() ||
						DEFAULT_SOCKET_CONFIG.waWebSocketUrl,
				),
				logger: logger,
			},
		} satisfies ClientConfig;

		this.auth = this.config.auth;
		this.logger = this.config.logger;

		this.messageProcessor = new MessageProcessor(this.logger, this.auth);

		this.conn = new ConnectionManager(
			this.config.wsOptions as WebSocketConfig,
			this.logger,
			this.auth.creds,
			this.messageProcessor,
		);

		const connectionActions: IConnectionActions = {
			sendNode: (node) => this.conn.sendNode(node),
			closeConnection: (error) => this.conn.close(error),
		};

		this.authenticator = new Authenticator(
			this.conn,
			this.auth,
			this.logger,
			connectionActions,
		);

		this.authenticator.addEventListener(
			"connection.update",
			(event: TypedCustomEvent<ConnectionUpdatePayload>) => {
				this.dispatchTypedEvent("connection.update", event.detail);
				if (event.detail.isNewLogin) {
					this.conn.reconnect();
				}
			},
		);

		this.authenticator.addEventListener(
			"creds.update",
			(event: TypedCustomEvent<CredsUpdatePayload>) => {
				this.auth
					.saveCreds()
					.then(() => {
						this.dispatchTypedEvent("creds.update", event.detail);
					})
					.catch((err) => {
						this.logger.error({ err }, "Failed to save credentials");
					});
			},
		);
		this.messageProcessor.addEventListener(
			"message.decrypted",
			(event: TypedCustomEvent<ClientEventMap["message.received"]>) => {
				this.dispatchTypedEvent("message.received", event.detail);
			},
		);

		this.messageProcessor.addEventListener(
			"message.decryption_error",
			(event: TypedCustomEvent<ClientEventMap["message.decryption_error"]>) => {
				this.logger.warn(
					{ err: event.detail.error, sender: event.detail.sender?.toString() },
					"Message decryption failed",
				);
				this.dispatchTypedEvent("message.decryption_error", event.detail);
			},
		);
	}

	addListener<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void {
		this.addEventListener(event, ((e: TypedCustomEvent<ClientEventMap[K]>) => {
			listener(e.detail);
		}) as EventListener);
	}

	async connect(): Promise<void> {
		try {
			await this.conn.connect();
		} catch (error) {
			this.logger.error({ err: error }, "Connection failed");
			throw error;
		}
	}

	async logout(reason = "User initiated logout"): Promise<void> {
		await this.conn.close(new Error(reason));
	}
}

export const createWAClient = (config: ClientConfig): WhaTSClient => {
	return new WhaTSClient(config);
};
