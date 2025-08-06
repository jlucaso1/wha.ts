import type { BinaryNode } from "@wha.ts/binary";
import type { DisconnectReason } from "../defaults";

export interface IConnectionActions {
	sendNode(node: BinaryNode): Promise<void>;

	closeConnection(error?: Error): Promise<void>;
}

export class ErrorWithStatusCode extends Error {
	public statusCode?: DisconnectReason;
}
