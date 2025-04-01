/**
 * The structure WhatsApp uses for binary XML-like communication
 * after the Noise encryption layer.
 */
import { Buffer } from "node:buffer";
export type BinaryNode = {
  tag: string;
  attrs: { [key: string]: string };
  content?: BinaryNode[] | string | Uint8Array | Buffer; // Allow Buffer for convenience
};

export type BinaryNodeAttributes = BinaryNode['attrs'];
export type BinaryNodeData = BinaryNode['content'];

// Placeholder for options if needed later for encoding/decoding variations
// export interface BinaryNodeCodingOptions {
//     tags: typeof TAGS;
//     tokenMap: { [token: string]: { dict?: number; index: number } };
// }