import type { SINGLE_BYTE_TOKENS_TYPE } from "./constants";

type NonStandardTag =
	| "ib"
	| "skey"
	| "offline_preview"
	| "offline_batch"
	| "registration"
	| "identity"
	| "list"
	| "device-identity"
	| "pair-device-sign"
	| "dirty";

type BinaryNodeTag = SINGLE_BYTE_TOKENS_TYPE | NonStandardTag;

export type BinaryNode = {
	tag: BinaryNodeTag;
	attrs: { [key: string]: string };
	content?: BinaryNode[] | string | Uint8Array;
};
