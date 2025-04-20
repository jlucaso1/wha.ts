import { create, toBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary/src/jid-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import {
	MessageSchema,
	Message_ExtendedTextMessageSchema,
} from "@wha.ts/proto";
import { SessionCipher } from "@wha.ts/signal/src";
import { padRandomMax16 } from "@wha.ts/utils/src/bytes-utils";
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
import { SignalProtocolStoreAdapter } from "./signal/signal-store";
import type { IAuthStateProvider } from "./state/interface";
import { generateMdTagPrefix } from "./state/utils";
import type { ILogger, WebSocketConfig } from "./transport/types";

interface ClientConfig {
	auth: IAuthStateProvider;
	logger?: ILogger;
	wsOptions?: Partial<WebSocketConfig>;
	version?: number[];
	browser?: readonly [string, string, string];
	connectionManager?: ConnectionManager;
}

declare interface WhaTSClient {
	ws: ConnectionManager["ws"];
	auth: IAuthStateProvider;
	logger: ILogger;
	signalStore: SignalProtocolStoreAdapter;

	connect(): Promise<void>;
	logout(reason?: string): Promise<void>;

	addListener<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void;
}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: solve later
class WhaTSClient extends TypedEventTarget<ClientEventMap> {
	private config: Omit<ClientConfig, "logger"> & { logger: ILogger };
	private messageProcessor: MessageProcessor;
	protected connectionManager: ConnectionManager;
	private authenticator: Authenticator;
	private epoch = 0;
	public signalStore: SignalProtocolStoreAdapter;

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

		this.signalStore = new SignalProtocolStoreAdapter(this.auth);

		this.messageProcessor = new MessageProcessor(this.logger, this.signalStore);

		this.connectionManager =
			config.connectionManager ??
			new ConnectionManager(
				this.config.wsOptions as WebSocketConfig,
				this.logger,
				this.auth.creds,
				this.messageProcessor,
			);

		const connectionActions: IConnectionActions = {
			sendNode: (node) => this.connectionManager.sendNode(node),
			closeConnection: (error) => this.connectionManager.close(error),
		};

		this.authenticator = new Authenticator(
			this.connectionManager,
			this.auth,
			this.logger,
			connectionActions,
		);

		this.authenticator.addEventListener(
			"connection.update",
			(event: TypedCustomEvent<ConnectionUpdatePayload>) => {
				this.dispatchTypedEvent("connection.update", event.detail);
				if (event.detail.isNewLogin) {
					this.connectionManager.reconnect();
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

		this.connectionManager.addEventListener(
			"node.received",
			(event: TypedCustomEvent<ClientEventMap["node.received"]>) => {
				this.dispatchTypedEvent("node.received", event.detail);
			},
		);
	}

	// Public method for test sanity check
	public isConnectionManagerReady(): boolean {
		return (
			!!this.connectionManager &&
			typeof this.connectionManager.connect === "function" &&
			typeof this.connectionManager.close === "function"
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
			await this.connectionManager.connect();
		} catch (error) {
			this.logger.error({ err: error }, "Connection failed");
			throw error;
		}
	}

	async logout(reason = "User initiated logout"): Promise<void> {
		await this.connectionManager.close(new Error(reason));
	}

	/**
	 * Sends a text message to a given JID.
	 * Handles encryption and session management automatically.
	 *
	 * @param jid The recipient's user JID (e.g., "1234567890@s.whatsapp.net").
	 * @param text The text content of the message.
	 * @param specificDeviceId Optional specific device ID to target. Defaults to 0 (primary device).
	 * @returns The unique message ID generated for this message.
	 * @throws Throws an error if the JID is invalid, encryption fails, or sending fails.
	 */
	async sendTextMessage(jid: string, text: string): Promise<string> {
		// 1. Validate JID and extract base user ID
		const decodedJid = jidDecode(jid);
		this.logger.debug(
			{ decodedJid, originalJid: jid },
			"Decoding JID for sending message",
		);
		if (!decodedJid || !decodedJid.user) {
			throw new Error(`Invalid JID for text message: ${jid}`);
		}
		const userId = `${decodedJid.user}@${decodedJid.server}`;

		// 2. Get all session records for the recipient
		const sessionRecords =
			await this.signalStore.getAllSessionRecordsForUser(userId);
		if (!sessionRecords.length) {
			this.logger.error({ userId }, "No active sessions found for recipient");
			throw new Error(`No active sessions found for recipient ${userId}`);
		}

		// 3. Prepare message proto and pad it (once)
		const protoMsg = create(MessageSchema, {
			extendedTextMessage: create(Message_ExtendedTextMessageSchema, {
				text: text,
			}),
		});
		const protoBytes = toBinary(MessageSchema, protoMsg);
		const paddedProtoBytes = padRandomMax16(protoBytes);

		// 4. Generate message ID (same for all devices)
		const msgId = `${generateMdTagPrefix()}-${this.epoch++}`;

		// 5. Encrypt and send for each device/session
		const nodesToSend: BinaryNode[] = [];
		for (const { address } of sessionRecords) {
			try {
				const cipher = new SessionCipher(this.signalStore, address);
				const encryptedResult = await cipher.encrypt(paddedProtoBytes);
				const encType = encryptedResult.type === 3 ? "pkmsg" : "msg";
				const messageNode: BinaryNode = {
					tag: "message",
					attrs: {
						to: userId,
						id: msgId,
					},
					content: [
						{
							tag: "enc",
							attrs: {
								v: "2",
								type: encType,
							},
							content: encryptedResult.body,
						},
					],
				};
				nodesToSend.push(messageNode);
			} catch (error) {
				this.logger.error(
					{ err: error, target: address.toString() },
					"Encryption failed for device, skipping",
				);
			}
		}

		this.logger.info(
			{ count: nodesToSend.length, userId },
			"Sending message nodes for device fanout",
		);

		// 6. Send all nodes
		try {
			for (const node of nodesToSend) {
				await this.connectionManager.sendNode(node);
			}
			return msgId;
		} catch (err) {
			this.logger.error(
				{ err, msgId, to: jid },
				"Failed to send one or more message nodes via ConnectionManager",
			);
			const errorMessage = err instanceof Error ? err.message : String(err);
			throw new Error(`Sending message node(s) failed: ${errorMessage}`);
		}
	}
}

export const createWAClient = (config: ClientConfig): WhaTSClient => {
	return new WhaTSClient(config);
};
