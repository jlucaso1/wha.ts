import type { BinaryNode } from "@wha.ts/binary/src/types";

export interface StateChangePayload {
	state: "connecting" | "open" | "handshaking" | "closing" | "closed";
	error?: Error;
}

type HandshakeCompletePayload = object;

export interface NodeReceivedPayload {
	node: BinaryNode;
}

interface NodeSentPayload {
	node: BinaryNode;
}

interface ErrorPayload {
	error: Error;
}

interface WsClosePayload {
	code: number;
	reason: string;
}

export interface ConnectionManagerEventMap {
	"state.change": StateChangePayload;
	"handshake.complete": HandshakeCompletePayload;
	"node.received": NodeReceivedPayload;
	"node.sent": NodeSentPayload;
	error: ErrorPayload;
	"ws.close": WsClosePayload;
}
