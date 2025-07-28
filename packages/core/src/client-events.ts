import type { fromBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import type { MessageSchema } from "@wha.ts/proto";
import type { ProtocolAddress } from "@wha.ts/signal";
import type {
	ConnectionUpdatePayload,
	CredsUpdatePayload,
} from "./core/authenticator-events";
import type { NodePayload } from "./core/connection-events";

/**
 * Map of event names to their respective payload types for the public API
 * This only exposes events that are meant to be used by consumers of the library
 */
export interface ClientEventMap {
	"connection.update": ConnectionUpdatePayload;
	"creds.update": CredsUpdatePayload;
	"message.received": {
		message: ReturnType<typeof fromBinary<typeof MessageSchema>>;
		sender: ProtocolAddress;
		rawNode: BinaryNode;
	};
	"message.decryption_error": {
		error: Error;
		rawNode: BinaryNode;
		sender?: ProtocolAddress;
	};
	"node.received": NodePayload;
	"node.sent": NodePayload;
}
