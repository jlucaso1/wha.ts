import { create, toBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary";
import type { BinaryNode } from "@wha.ts/binary";
import {
	MessageSchema,
	Message_ExtendedTextMessageSchema,
} from "@wha.ts/proto";
import { SessionCipher } from "@wha.ts/signal";
import { padRandomMax16 } from "@wha.ts/utils";
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
	/**
	 * Sends a text message to a given JID and waits for server ACK.
	 * Returns messageId, and either ack or error.
	 */
	async sendTextMessage(
		jid: string,
		text: string,
	): Promise<{ messageId: string; ack?: BinaryNode; error?: string }> {
		const decodedJid = jidDecode(jid);
		this.logger.debug(
			{ decodedJid, originalJid: jid },
			"Decoding JID for sending message",
		);
		if (!decodedJid || !decodedJid.user) {
			throw new Error(`Invalid JID for text message: ${jid}`);
		}
		const userId = `${decodedJid.user}@${decodedJid.server}`;

		const sessionRecords =
			await this.signalStore.getAllSessionRecordsForUser(userId);
		if (!sessionRecords.length) {
			this.logger.error({ userId }, "No active sessions found for recipient");
			throw new Error(`No active sessions found for recipient ${userId}`);
		}

		const protoMsg = create(MessageSchema, {
			extendedTextMessage: create(Message_ExtendedTextMessageSchema, {
				text: text,
			}),
		});
		const protoBytes = toBinary(MessageSchema, protoMsg);
		const paddedProtoBytes = padRandomMax16(protoBytes);

		const msgId = `${generateMdTagPrefix()}-${this.epoch++}`;
		const nodesToSend: BinaryNode[] = [];

		for (const { address } of sessionRecords) {
			try {
				const cipher = new SessionCipher(this.signalStore, address);
				const encryptedResult = await cipher.encrypt(paddedProtoBytes);
				const encType = encryptedResult.type === 3 ? "pkmsg" : "msg";
				const { user, server } = jidDecode(jid) || {};
				const recipientJid = `${user}@${server}`;
				const messageNode: BinaryNode = {
					tag: "message",
					attrs: {
						to: recipientJid,
						id: msgId,
						type: "text",
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

		if (nodesToSend.length === 0) {
			this.logger.error(
				{ userId },
				"No message nodes could be prepared for sending (all encryptions failed).",
			);
			throw new Error("Failed to prepare message for any recipient device.");
		}

		this.logger.info(
			{ count: nodesToSend.length, userId, msgId },
			"Sending message nodes for device fanout",
		);

		try {
			for (const node of nodesToSend) {
				await this.connectionManager.sendNode(node);
			}
		} catch (sendError) {
			this.logger.error(
				{ err: sendError, msgId, to: jid },
				"Failed to send one or more message nodes via ConnectionManager",
			);
			const errorMessage =
				sendError instanceof Error ? sendError.message : String(sendError);
			throw new Error(`Sending message node(s) failed: ${errorMessage}`);
		}

		try {
			const ackNode = await this.waitForMessageAck(msgId);
			return { messageId: msgId, ack: ackNode };
		} catch (ackError) {
			this.logger.warn(
				{ err: ackError, msgId, to: jid },
				"Error while waiting for message ack, or ack contained an error.",
			);
			return {
				messageId: msgId,
				error: ackError instanceof Error ? ackError.message : String(ackError),
			};
		}
	}

	/**
	 * Waits for an ACK node matching the given messageId, or rejects on error/timeout.
	 */
	private waitForMessageAck(messageId: string, timeoutMs = 15000) {
		return new Promise<BinaryNode>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				cleanup();
				reject(
					new Error(
						`Timeout waiting for ack for message ${messageId} after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			const listener = (event: TypedCustomEvent<{ node: BinaryNode }>) => {
				const ackNode = event.detail.node;
				if (ackNode.tag === "ack" && ackNode.attrs.id === messageId) {
					this.logger.debug(
						{ ackAttrs: ackNode.attrs, forMsgId: messageId },
						"Received ack for message",
					);
					cleanup();
					if (ackNode.attrs.error) {
						const errorText =
							ackNode.attrs.text || `Server error ${ackNode.attrs.error}`;
						reject(
							new Error(
								`Message delivery failed (ack error ${ackNode.attrs.error}): ${errorText} for ID ${messageId}. Full attrs: ${JSON.stringify(ackNode.attrs)}`,
							),
						);
					} else {
						resolve(ackNode);
					}
				}
			};

			const cleanup = () => {
				clearTimeout(timeoutId);
				this.connectionManager.removeEventListener(
					"node.received",
					listener as EventListener,
				);
			};

			this.connectionManager.addEventListener(
				"node.received",
				listener as EventListener,
			);
		});
	}
}

export const createWAClient = (config: ClientConfig): WhaTSClient => {
	return new WhaTSClient(config);
};
