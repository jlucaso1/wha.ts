import type { BinaryNode } from "@wha.ts/binary/src/types";

/**
 * Minimal interface for actions Authenticator can perform on the connection.
 */
export interface IConnectionActions {
	/**
	 * Send a BinaryNode to the connection.
	 * @param node The node to send.
	 */
	sendNode(node: BinaryNode): Promise<void>;

	/**
	 * Close the connection, optionally with an error.
	 * @param error Optional error to provide context for the closure.
	 */
	closeConnection(error?: Error): Promise<void>;
}
