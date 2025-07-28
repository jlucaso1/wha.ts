import type { BinaryNode } from "@wha.ts/binary";
import { getBinaryNodeChild, S_WHATSAPP_NET } from "@wha.ts/binary";
import { DisconnectReason } from "../defaults";
import type { MessageProcessor } from "../messaging/message-processor";
import { generateMdTagPrefix } from "../state/utils";
import type { ILogger } from "../transport/types";
import type { ConnectionState } from "./connection-events";

interface IConnectionManagerActions {
	setState(newState: ConnectionState, error?: Error): void;
	sendNode(node: BinaryNode): Promise<void>;
	close(error?: Error): Promise<void>;
	dispatchTypedEvent(
		type: "node.received",
		payload: { node: BinaryNode },
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

		if (getBinaryNodeChild(node, "enc")) {
			this.messageProcessor.processIncomingNode(node).catch((err) => {
				this.logger.error(
					{ err, nodeTag: node.tag, from: node.attrs.from },
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

		let error: Error;
		if (code === "515") {
			error = new Error("Restart Required");
			(error as any).statusCode = DisconnectReason.restartRequired;
		} else {
			error = new Error(message);
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
			tag: "iq",
			attrs: {
				to: node.attrs.from,
				type: "result",
				xmlns: "w:p",
				id: `${generateMdTagPrefix()}-${this.epoch++}`,
			},
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
