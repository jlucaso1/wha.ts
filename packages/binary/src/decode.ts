import { decodeNode } from "whatsapp-rust-bridge";
import type { BinaryNode } from "./types";

export const decodeBinaryNode = (encodedBuffer: Uint8Array): BinaryNode => {
	return decodeNode(encodedBuffer) as BinaryNode;
};
