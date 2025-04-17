import { fromBinary } from "@bufbuild/protobuf";
import { jidDecode } from "@wha.ts/binary/src/jid-utils";
import { getBinaryNodeChild } from "@wha.ts/binary/src/node-utils";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import { MessageSchema } from "@wha.ts/proto";
import { ProtocolAddress, SessionCipher } from "@wha.ts/signal/src";
import { unpadRandomMax16 } from "@wha.ts/utils/src/bytes-utils";
import { TypedEventTarget } from "../generics/typed-event-target";
import { SignalProtocolStoreAdapter } from "../signal/signal-store";
import type { IAuthStateProvider } from "../state/interface";
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

export class MessageProcessor extends TypedEventTarget<MessageProcessorEventMap> {
	private logger: ILogger;
	private signalStore: SignalProtocolStoreAdapter;
	private authStateProvider: IAuthStateProvider;

	constructor(logger: ILogger, authStateProvider: IAuthStateProvider) {
		super();
		this.logger = logger;
		this.authStateProvider = authStateProvider;
		this.signalStore = new SignalProtocolStoreAdapter(this.authStateProvider);
	}

	async processIncomingNode(node: BinaryNode): Promise<void> {
		if (node.tag !== "message") {
			return;
		}
		const encNode = getBinaryNodeChild(node, "enc");
		if (!encNode) {
			return;
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

			if (type === "pkmsg") {
				plaintextBuffer = await cipher.decryptPreKeyWhisperMessage(ciphertext);
			} else if (type === "msg") {
				plaintextBuffer = await cipher.decryptWhisperMessage(ciphertext);
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

			this.logger.info(
				{
					type,
					from: senderAddress.toString(),
					size: plaintext.length,
				},
				"[MessageProcessor] Successfully decrypted message",
			);

			this.dispatchTypedEvent("message.decrypted", {
				message,
				sender: senderAddress,
				rawNode: node,
			});
		} catch (error: any) {
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
		}
	}
}
