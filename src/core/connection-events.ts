import type { BinaryNode } from "../binary/types";

/**
 * Payload for state.change events
 */
export interface StateChangePayload {
	state: "connecting" | "open" | "handshaking" | "closing" | "closed";
	error?: Error;
}

/**
 * Payload for handshake.complete events (empty for now, structure can be expanded later)
 */
export type HandshakeCompletePayload = object;

/**
 * Payload for node.received events
 */
export interface NodeReceivedPayload {
	node: BinaryNode;
}

/**
 * Payload for node.sent events
 */
export interface NodeSentPayload {
	node: BinaryNode;
}

/**
 * Payload for error events
 */
export interface ErrorPayload {
	error: Error;
}

/**
 * Payload for ws.close events
 */
export interface WsClosePayload {
	code: number;
	reason: string;
}

/**
 * Map of event names to their respective payload types for ConnectionManager
 */
export interface ConnectionManagerEventMap {
	"state.change": StateChangePayload;
	"handshake.complete": HandshakeCompletePayload;
	"node.received": NodeReceivedPayload;
	"node.sent": NodeSentPayload;
	error: ErrorPayload;
	"ws.close": WsClosePayload;
}
