import type { fromBinary } from "@bufbuild/protobuf";
import type { BinaryNode } from "@wha.ts/binary";
import type { MessageSchema } from "@wha.ts/proto";
import type { ProtocolAddress } from "@wha.ts/signal";
import type {
	ConnectionUpdatePayload,
	CredsUpdatePayload,
} from "./core/authenticator-events";
import type { NodePayload } from "./core/connection-events";

declare module "@wha.ts/types" {
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
}

// biome-ignore lint/complexity/noUselessEmptyExport: This file needs to be a module
export {};
