import type {
	ConnectionUpdatePayload,
	CredsUpdatePayload,
} from "./core/authenticator-events";

/**
 * Map of event names to their respective payload types for the public API
 * This only exposes events that are meant to be used by consumers of the library
 */
export interface ClientEventMap {
	"connection.update": ConnectionUpdatePayload;
	"creds.update": CredsUpdatePayload;
}
