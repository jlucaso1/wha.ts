import { utf8ToBytes } from "@wha.ts/core/src/utils/bytes-utils";
import { TAGS, TOKEN_MAP } from "../constants";
import { type FullJid, jidDecode } from "./jid-utils";
import type { BinaryNode } from "./types";
import { BinaryWriter } from "./writer";

export const encodeBinaryNode = (node: BinaryNode): Uint8Array => {
	const writer = new BinaryWriter();
	writer.writeByte(0);
	encodeBinaryNodeInner(node, writer);
	return writer.getData();
};

const encodeBinaryNodeInner = (
	{ tag, attrs, content }: BinaryNode,
	writer: BinaryWriter,
): void => {
	const writeByteLength = (length: number) => {
		if (length >= 4294967296) {
			throw new Error(`string too large to encode: ${length}`);
		}
		if (length >= 1 << 20) {
			writer.writeByte(TAGS.BINARY_32);
			writer.writeInt(length, 4);
		} else if (length >= 256) {
			writer.writeByte(TAGS.BINARY_20);
			writer.writeInt20(length);
		} else {
			writer.writeByte(TAGS.BINARY_8);
			writer.writeByte(length);
		}
	};

	const writeStringRaw = (str: string) => {
		const bytes = utf8ToBytes(str);
		writeByteLength(bytes.length);
		writer.writeBytes(bytes);
	};

	const writeJid = ({ domainType, device, user, server }: FullJid) => {
		if (typeof device !== "undefined") {
			writer.writeByte(TAGS.AD_JID);
			writer.writeByte(domainType || 0);
			writer.writeByte(device || 0);
			if (user) {
				writeString(user);
			}
		} else {
			writer.writeByte(TAGS.JID_PAIR);
			if (user?.length) {
				writeString(user);
			} else {
				writer.writeByte(TAGS.LIST_EMPTY);
			}
			writeString(server ?? "");
		}
	};

	const packNibble = (char: string) => {
		switch (char) {
			case "-":
				return 10;
			case ".":
				return 11;
			case "\0":
				return 15;
			default:
				if (char >= "0" && char <= "9") {
					return char.charCodeAt(0) - "0".charCodeAt(0);
				}
				throw new Error(`invalid byte for nibble "${char}"`);
		}
	};

	const packHex = (char: string) => {
		if (char >= "0" && char <= "9") {
			return char.charCodeAt(0) - "0".charCodeAt(0);
		}
		if (char >= "A" && char <= "F") {
			return 10 + char.charCodeAt(0) - "A".charCodeAt(0);
		}
		if (char >= "a" && char <= "f") {
			return 10 + char.charCodeAt(0) - "a".charCodeAt(0);
		}
		if (char === "\0") {
			return 15;
		}
		throw new Error(`Invalid hex char "${char}"`);
	};

	const writePackedBytes = (str: string, type: "nibble" | "hex") => {
		if (str.length > TAGS.PACKED_MAX) {
			throw new Error("Too many bytes to pack");
		}
		writer.writeByte(type === "nibble" ? TAGS.NIBBLE_8 : TAGS.HEX_8);
		let roundedLength = Math.ceil(str.length / 2);
		if (str.length % 2 !== 0) {
			roundedLength |= 128;
		}
		writer.writeByte(roundedLength);
		const packFunction = type === "nibble" ? packNibble : packHex;
		const packBytePair = (v1: string, v2: string) =>
			(packFunction(v1) << 4) | packFunction(v2);
		const strLengthHalf = Math.floor(str.length / 2);
		for (let i = 0; i < strLengthHalf; i++) {
			writer.writeByte(
				packBytePair(str[2 * i] ?? "\x00", str[2 * i + 1] ?? "\x00"),
			);
		}
		if (str.length % 2 !== 0) {
			writer.writeByte(packBytePair(str[str.length - 1] ?? "\x00", "\x00"));
		}
	};

	const isNibble = (str: string) => {
		if (str.length > TAGS.PACKED_MAX) return false;
		for (const char of str) {
			const isInNibbleRange = char >= "0" && char <= "9";
			if (!isInNibbleRange && char !== "-" && char !== ".") return false;
		}
		return true;
	};

	const isHex = (str: string) => {
		if (str.length > TAGS.PACKED_MAX) return false;
		for (const char of str) {
			const isInNibbleRange = char >= "0" && char <= "9";
			if (!isInNibbleRange && !(char >= "A" && char <= "F")) return false;
		}
		return true;
	};

	const writeString = (str: string) => {
		const tokenIndex = TOKEN_MAP[str];
		if (tokenIndex) {
			if (typeof tokenIndex.dict === "number") {
				writer.writeByte(TAGS.DICTIONARY_0 + tokenIndex.dict);
			}
			writer.writeByte(tokenIndex.index);
		} else if (isNibble(str)) {
			writePackedBytes(str, "nibble");
		} else if (isHex(str)) {
			writePackedBytes(str, "hex");
		} else if (str) {
			const decodedJid = jidDecode(str);
			if (decodedJid) {
				writeJid(decodedJid);
			} else {
				writeStringRaw(str);
			}
		}
	};

	const validAttributes = Object.keys(attrs).filter(
		(attrName) =>
			typeof attrs[attrName] !== "undefined" && attrs[attrName] !== null,
	);

	const listSize =
		2 * validAttributes.length + 1 + (typeof content !== "undefined" ? 1 : 0);

	if (listSize === 0) {
		writer.writeByte(TAGS.LIST_EMPTY);
	} else if (listSize < 256) {
		writer.writeByte(TAGS.LIST_8);
		writer.writeByte(listSize);
	} else {
		writer.writeByte(TAGS.LIST_16);
		writer.writeInt16(listSize);
	}

	writeString(tag);

	for (const key of validAttributes) {
		if (typeof attrs[key] === "string") {
			writeString(key);
			writeString(attrs[key]);
		}
	}

	if (typeof content === "string") {
		writeString(content);
	} else if (content instanceof Uint8Array) {
		writeByteLength(content.length);
		writer.writeBytes(content);
	} else if (Array.isArray(content)) {
		if (content.length === 0) {
			writer.writeByte(TAGS.LIST_EMPTY);
		} else if (content.length < 256) {
			writer.writeByte(TAGS.LIST_8);
			writer.writeByte(content.length);
		} else {
			writer.writeByte(TAGS.LIST_16);
			writer.writeInt16(content.length);
		}
		for (const item of content) {
			encodeBinaryNodeInner(item, writer);
		}
	}
};
