import "./client-events";
import { create, toBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import { jidDecode } from "@wha.ts/binary";
import {
	Message_ExtendedTextMessageSchema,
	MessageSchema,
} from "@wha.ts/proto";
import { SessionCipher } from "@wha.ts/signal";
import type {
	ClientEventMap,
	IAuthStateProvider,
	IPlugin,
	MergePlugins,
} from "@wha.ts/types";
import {
	type TypedCustomEvent,
	TypedEventTarget,
} from "@wha.ts/types/generics/typed-event-target";
import { generateMdTagPrefix, padRandomMax16 } from "@wha.ts/utils";
import { Authenticator } from "./core/authenticator";
import type {
	ConnectionUpdatePayload,
	CredsUpdatePayload,
} from "./core/authenticator-events";
import { ConnectionManager } from "./core/connection";
import type { IConnectionActions } from "./core/types";
import { DEFAULT_BROWSER, DEFAULT_SOCKET_CONFIG, WA_VERSION } from "./defaults";
import { MessageProcessor } from "./messaging/message-processor";
import { PluginManager } from "./plugins/plugin-manager";
import { PreKeyManager } from "./prekeys";
import { PresenceManager } from "./presence";
import { SignalProtocolStoreAdapter } from "./signal/signal-store";
import type { ILogger, WebSocketConfig } from "./transport/types";

interface ClientConfig<
	_TStorage,
	TPlugins extends readonly IPlugin[] = readonly [],
> {
	auth: IAuthStateProvider;
	logger?: ILogger;
	wsOptions?: Partial<WebSocketConfig>;
	version?: number[];
	browser?: readonly [string, string, string];
	connectionManager?: ConnectionManager;
	plugins?: TPlugins;
}

export declare interface WhaTSClient {
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
export class WhaTSClient<
	_TStorage = unknown,
	TPlugins extends readonly IPlugin[] = readonly [],
> extends TypedEventTarget<ClientEventMap> {
	private config: Omit<ClientConfig<_TStorage, TPlugins>, "logger"> & {
		logger: ILogger;
	};
	private messageProcessor: MessageProcessor;
	protected connectionManager: ConnectionManager;
	private authenticator: Authenticator;
	private epoch = 0;
	private pluginManager: PluginManager;
	public signalStore: SignalProtocolStoreAdapter;
	private preKeyManager: PreKeyManager;
	private presenceManager: PresenceManager;

	constructor(config: ClientConfig<_TStorage, TPlugins>) {
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
			plugins: config.plugins,
		} satisfies ClientConfig<_TStorage, TPlugins>;

		this.auth = this.config.auth;
		this.logger = this.config.logger;

		this.signalStore = new SignalProtocolStoreAdapter(this.auth, this.logger);

		const allPlugins: IPlugin[] = this.config.plugins
			? [...this.config.plugins]
			: [];

		this.pluginManager = new PluginManager(this, allPlugins);
		this.pluginManager.installAll();

		const exposedApis = this.pluginManager.getExposedApis();
		Object.assign(this, exposedApis);

		const preDecryptCallbacks = this.pluginManager.getPreDecryptTaps();
		const combinedPreDecryptCallback =
			preDecryptCallbacks.length > 0
				? (node: BinaryNode) => {
						for (const callback of preDecryptCallbacks) {
							try {
								callback(node);
							} catch (error) {
								this.logger.error(
									{ err: error },
									"Plugin pre-decrypt callback failed",
								);
							}
						}
					}
				: undefined;

		this.messageProcessor = new MessageProcessor(
			this.logger,
			this.signalStore,
			this.auth.keys,
			this.auth,
			combinedPreDecryptCallback,
		);

		this.connectionManager =
			config.connectionManager ??
			new ConnectionManager(
				this.config.wsOptions as WebSocketConfig,
				this.logger,
				this.auth.creds,
				this.messageProcessor,
			);

		this.presenceManager = new PresenceManager(
			this.connectionManager,
			this.auth,
			this.logger,
		);

		this.preKeyManager = new PreKeyManager(
			this.auth,
			this.logger,
			this.connectionManager,
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
				if (event.detail.connection === "open" && this.auth.creds.me?.id) {
					this.preKeyManager.checkAndUploadPreKeys().catch((err) => {
						this.logger.error({ err }, "Initial pre-key check failed");
					});
				}
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

		this.connectionManager.addEventListener(
			"node.sent",
			(event: TypedCustomEvent<ClientEventMap["node.sent"]>) => {
				this.dispatchTypedEvent("node.sent", event.detail);
			},
		);
	}

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
								`Message delivery failed (ack error ${
									ackNode.attrs.error
								}): ${errorText} for ID ${messageId}. Full attrs: ${JSON.stringify(
									ackNode.attrs,
								)}`,
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

	async reconnect(): Promise<void> {
		return this.connectionManager.reconnect();
	}

	public async sendPresenceUpdate(
		...args: Parameters<PresenceManager["sendUpdate"]>
	): Promise<void> {
		return this.presenceManager.sendUpdate(...args);
	}
}

export const createWAClient = <
	_TStorage = unknown,
	const TPlugins extends readonly IPlugin[] = readonly [],
>(
	config: ClientConfig<_TStorage, TPlugins>,
): WhaTSClient<_TStorage, TPlugins> & MergePlugins<TPlugins> => {
	return new WhaTSClient(config) as WhaTSClient<_TStorage, TPlugins> &
		MergePlugins<TPlugins>;
};
