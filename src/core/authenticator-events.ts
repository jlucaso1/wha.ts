import type { BinaryNode } from "../binary/types";
import type { AuthenticationCreds } from "../state/interface";

/**
 * Payload for connection.update events
 */
export interface ConnectionUpdatePayload {
	connection?: "connecting" | "open" | "close";
	isNewLogin?: boolean;
	qr?: string;
	error?: Error;
}

/**
 * Payload for creds.update events
 */
export type CredsUpdatePayload = Partial<AuthenticationCreds>;

/**
 * Payload for _internal.sendNode events
 */
export interface InternalSendNodePayload {
	node: BinaryNode;
}

/**
 * Payload for _internal.closeConnection events
 */
export interface InternalCloseConnectionPayload {
	error?: Error;
}

/**
 * Map of event names to their respective payload types for Authenticator
 */
export interface AuthenticatorEventMap {
	"connection.update": ConnectionUpdatePayload;
	"creds.update": CredsUpdatePayload;
	"_internal.sendNode": InternalSendNodePayload;
	"_internal.closeConnection": InternalCloseConnectionPayload;
}
