import type { BinaryNode } from "@wha.ts/binary";
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	S_WHATSAPP_NET,
} from "@wha.ts/binary";
import type { ILogger } from "@wha.ts/types/transport";
import { generateMdTagPrefix } from "@wha.ts/utils/generic";
import { DisconnectReason } from "../defaults";
import type { MessageProcessor } from "../messaging/message-processor";
import type {
	ConnectionManagerEventMap,
	ConnectionState,
} from "./connection-events";
import { ErrorWithStatusCode } from "./types";

interface IConnectionManagerActions {
	setState(newState: ConnectionState, error?: Error): void;
	sendNode(node: BinaryNode): Promise<void>;
	close(error?: Error): Promise<void>;
	dispatchTypedEvent<K extends keyof ConnectionManagerEventMap>(
		type: K,
		payload: ConnectionManagerEventMap[K],
	): void;
}

export class IncomingNodeHandler {
	private epoch = 0;
	constructor(
		private connection: IConnectionManagerActions,
		private messageProcessor: MessageProcessor,
		private logger: ILogger,
	) {}

	/**
	 * Processes a decrypted BinaryNode from the server.
	 * This is the single entry point for all incoming stanzas after the handshake.
	 */
	public processNode(node: BinaryNode, currentState: ConnectionState): void {
		if (currentState === "authenticating" && node.tag === "success") {
			this.logger.info(
				"Authentication successful, connection is now fully open.",
			);
			this.connection.setState("open");
		}

		if (this.handleStreamError(node)) {
			return;
		}

		if (this.handlePing(node)) {
			return;
		}

		if (node.tag === "notification") {
			const notificationType = node.attrs.type;
			if (notificationType === "server_sync") {
				this.logger.info(
					"Received `server_sync` notification, dispatching sync event.",
				);
				const collections = getBinaryNodeChildren(node, "collection");
				for (const collectionNode of collections) {
					const name = collectionNode.attrs.name;
					if (name) {
						this.logger.info(
							`Dispatching sync event for collection '${name}'.`,
						);
						this.connection.dispatchTypedEvent("sync.received", { name });
					}
				}
				return;
			}
		}

		if (getBinaryNodeChild(node, "enc")) {
			this.messageProcessor.processIncomingNode(node).catch((err) => {
				this.logger.error(
					{ err, from: node.attrs.from, nodeTag: node.tag },
					"Error processing encrypted node in MessageProcessor",
				);
			});
		} else {
			this.connection.dispatchTypedEvent("node.received", { node });
		}
	}

	private handleStreamError(node: BinaryNode): boolean {
		if (node.tag !== "stream:error") {
			return false;
		}

		const code = node.attrs.code;
		const message = `Stream Error (code: ${code})`;
		this.logger.warn({ node }, message);

		let error: ErrorWithStatusCode;
		if (code === "515") {
			error = new ErrorWithStatusCode("Restart Required");
			error.statusCode = DisconnectReason.restartRequired;
		} else {
			error = new ErrorWithStatusCode(message);
		}

		this.connection.close(error);
		return true;
	}

	private handlePing(node: BinaryNode): boolean {
		if (
			node.tag !== "iq" ||
			node.attrs.from !== S_WHATSAPP_NET ||
			node.attrs.type !== "get" ||
			node.attrs.xmlns !== "urn:xmpp:ping"
		) {
			return false;
		}

		this.logger.debug({ id: node.attrs.id }, "Responding to ping");
		const pongNode: BinaryNode = {
			attrs: {
				id: `${generateMdTagPrefix()}-${this.epoch++}`,
				to: node.attrs.from,
				type: "result",
				xmlns: "w:p",
			},
			tag: "iq",
		};
		this.connection.sendNode(pongNode).catch((err) => {
			this.logger.warn(
				{ err, id: node.attrs.id },
				"Failed to send pong response",
			);
		});
		return true;
	}
}
