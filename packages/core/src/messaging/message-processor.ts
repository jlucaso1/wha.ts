import { fromBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import { getBinaryNodeChild, jidDecode } from "@wha.ts/binary";
import { MessageSchema } from "@wha.ts/proto";
import { ProtocolAddress, SessionCipher } from "@wha.ts/signal";
import { GroupCipher } from "@wha.ts/signal/groups/cipher";
import { TypedEventTarget } from "@wha.ts/types/generics/typed-event-target";
import { unpadRandomMax16 } from "@wha.ts/utils";
import type { SignalProtocolStoreAdapter } from "../signal/signal-store";
import type {
	IAuthStateProvider,
	ISignalProtocolStore,
} from "../state/interface";
import type { ILogger } from "../transport/types";

interface MessageProcessorEventMap {
	"message.decrypted": {
		message: ReturnType<typeof fromBinary<typeof MessageSchema>>;
		sender: ProtocolAddress;
		rawNode: BinaryNode;
	};
	"message.decryption_error": {
		error: Error;
		rawNode: BinaryNode;
		sender?: ProtocolAddress;
	};
}

type PreDecryptCallback = (node: BinaryNode) => void | Promise<void>;

export class MessageProcessor extends TypedEventTarget<MessageProcessorEventMap> {
	private logger: ILogger;
	private signalStore: SignalProtocolStoreAdapter;
	private genericStore: ISignalProtocolStore;
	private authState: IAuthStateProvider;
	private onPreDecrypt?: PreDecryptCallback;
	private processedMessages = new Set<string>();
	private readonly MAX_PROCESSED_MESSAGES = 2000;

	constructor(
		logger: ILogger,
		signalStore: SignalProtocolStoreAdapter,
		genericStore: ISignalProtocolStore,
		authState: IAuthStateProvider,
		onPreDecrypt?: PreDecryptCallback,
	) {
		super();
		this.logger = logger;
		this.signalStore = signalStore;
		this.genericStore = genericStore;
		this.authState = authState;
		this.onPreDecrypt = onPreDecrypt;

		this.authState.creds.processedMessages?.forEach((key) => {
			this.processedMessages.add(`${key.chat}|${key.id}`);
		});
	}

	private async markMessageAsProcessed(
		chat: string,
		id: string,
	): Promise<void> {
		const key = `${chat}|${id}`;
		this.processedMessages.add(key);

		if (!this.authState.creds.processedMessages) {
			this.authState.creds.processedMessages = [];
		}

		this.authState.creds.processedMessages.push({ chat, id });

		while (
			this.authState.creds.processedMessages.length >
			this.MAX_PROCESSED_MESSAGES
		) {
			const removed = this.authState.creds.processedMessages.shift();
			if (removed) {
				this.processedMessages.delete(`${removed.chat}|${removed.id}`);
			}
		}

		await this.authState.saveCreds();
	}

	async processIncomingNode(node: BinaryNode): Promise<void> {
		if (node.tag !== "message") {
			return;
		}

		const { from: chatJid, id: messageId } = node.attrs;

		if (messageId && chatJid) {
			const messageKey = `${chatJid}|${messageId}`;
			if (this.processedMessages.has(messageKey)) {
				this.logger.info({ key: messageKey }, "Ignoring duplicate message");
				return;
			}
		}

		const encNode = getBinaryNodeChild(node, "enc");
		if (!encNode) {
			return;
		}

		if (this.onPreDecrypt) {
			try {
				await Promise.resolve(this.onPreDecrypt(node));
			} catch (err) {
				this.logger.error({ err }, "Pre-decryption callback failed");
			}
		}

		const { from: senderJidWithDevice, participant } = node.attrs;
		const ciphertext = encNode?.content;
		const type = encNode?.attrs.type;
		const effectiveSenderJid = participant || senderJidWithDevice;

		if (
			!effectiveSenderJid ||
			typeof effectiveSenderJid !== "string" ||
			!(ciphertext instanceof Uint8Array) ||
			ciphertext.length === 0 ||
			!type
		) {
			this.logger.warn(
				{ attrs: node.attrs, content_type: typeof ciphertext, type },
				"[MessageProcessor] Received invalid encrypted node structure",
			);
			this.dispatchTypedEvent("message.decryption_error", {
				error: new Error("Invalid encrypted node structure"),
				rawNode: node,
			});
			return;
		}

		let senderAddress: ProtocolAddress | undefined;
		try {
			const decodedJid = jidDecode(effectiveSenderJid);
			if (!decodedJid || !decodedJid.user) {
				throw new Error(`Cannot decode JID: ${effectiveSenderJid}`);
			}
			senderAddress = new ProtocolAddress(
				decodedJid.user,
				decodedJid.device ?? 0,
			);

			const cipher = new SessionCipher(this.signalStore, senderAddress);

			let plaintextBuffer: Uint8Array;
			const groupJid = senderJidWithDevice;
			const senderJid = participant;

			if (type === "pkmsg") {
				plaintextBuffer = await cipher.decryptPreKeyWhisperMessage(ciphertext);
			} else if (type === "msg") {
				plaintextBuffer = await cipher.decryptWhisperMessage(ciphertext);
			} else if (type === "skmsg") {
				if (!senderJid)
					throw new Error("skmsg is missing 'participant' attribute");

				const senderKeyName = `${groupJid}::${senderJid}`;
				const groupCipher = new GroupCipher(this.genericStore, senderKeyName);

				const rawProtoBytes = ciphertext.slice(1, -8);

				plaintextBuffer = await groupCipher.decrypt(rawProtoBytes);
			} else {
				this.logger.warn(
					{ type, from: senderAddress.toString() },
					"[MessageProcessor] Received encrypted node with unknown type",
				);
				this.dispatchTypedEvent("message.decryption_error", {
					error: new Error(`Unknown encryption type: ${type}`),
					rawNode: node,
					sender: senderAddress,
				});
				return;
			}

			const isPlaintext = node.attrs.type === "plaintext";
			const plaintext = isPlaintext
				? plaintextBuffer
				: unpadRandomMax16(plaintextBuffer);

			const message = fromBinary(MessageSchema, plaintext);

			if (messageId && chatJid) {
				await this.markMessageAsProcessed(chatJid, messageId);
			}

			this.dispatchTypedEvent("message.decrypted", {
				message,
				sender: senderAddress,
				rawNode: node,
			});
		} catch (error) {
			if (messageId && chatJid) {
				await this.markMessageAsProcessed(chatJid, messageId);
			}
			if (error instanceof Error) {
				const isKeyError = /Key used already or never filled/i.test(
					error.message,
				);

				if (isKeyError) {
					this.dispatchTypedEvent("message.decryption_error", {
						error: new Error(`Discarded: ${error.message}`),
						rawNode: node,
						sender: senderAddress,
					});
				} else {
					this.dispatchTypedEvent("message.decryption_error", {
						error,
						rawNode: node,
						sender: senderAddress,
					});
				}
			} else {
				this.dispatchTypedEvent("message.decryption_error", {
					error: new Error(`Unknown error: ${String(error)}`),
					rawNode: node,
					sender: senderAddress,
				});
			}
		}
	}
}
