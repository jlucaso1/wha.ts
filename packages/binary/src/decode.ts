import { deflateSync } from "fflate";
import {
	DOUBLE_BYTE_TOKENS,
	SINGLE_BYTE_TOKENS,
	type SINGLE_BYTE_TOKENS_TYPE,
	TAGS,
} from "./constants";
import { jidEncode } from "./jid-utils";
import { BinaryReader } from "./reader";
import type { BinaryNode } from "./types";

const decompressingIfRequired = (originalBuffer: Uint8Array) => {
	const prefix = originalBuffer[0];

	const buffer = originalBuffer.slice(1);
	if (prefix && (prefix & 2) !== 0) {
		const decompressedData = deflateSync(buffer);
		return decompressedData;
	}
	return buffer;
};

const decodeDecompressedBinaryNode = (reader: BinaryReader): BinaryNode => {
	const unpackHex = (value: number) => {
		if (value >= 0 && value < 16) {
			return value < 10
				? "0".charCodeAt(0) + value
				: "A".charCodeAt(0) + value - 10;
		}
		throw new Error(`invalid hex: ${value}`);
	};

	const unpackNibble = (value: number) => {
		if (value >= 0 && value <= 9) {
			return "0".charCodeAt(0) + value;
		}
		switch (value) {
			case 10:
				return "-".charCodeAt(0);
			case 11:
				return ".".charCodeAt(0);
			case 15:
				return "\0".charCodeAt(0);
			default:
				throw new Error(`invalid nibble: ${value}`);
		}
	};

	const unpackByte = (tag: number, value: number) => {
		if (tag === TAGS.NIBBLE_8) {
			return unpackNibble(value);
		}
		if (tag === TAGS.HEX_8) {
			return unpackHex(value);
		}
		throw new Error(`unknown tag: ${tag}`);
	};

	const readPacked8 = (tag: number) => {
		const startByte = reader.readByte();
		let value = "";
		for (let i = 0; i < (startByte & 127); i++) {
			const curByte = reader.readByte();
			value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4));
			value += String.fromCharCode(unpackByte(tag, curByte & 0x0f));
		}
		if (startByte >> 7 !== 0) {
			value = value.slice(0, -1);
		}
		return value;
	};

	const isListTag = (tag: number) =>
		tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16;

	const readListSize = (tag: number) => {
		switch (tag) {
			case TAGS.LIST_EMPTY:
				return 0;
			case TAGS.LIST_8:
				return reader.readByte();
			case TAGS.LIST_16:
				return reader.readInt(2);
			default:
				throw new Error(`invalid tag for list size: ${tag}`);
		}
	};

	const readJidPair = () => {
		const userPart = readString(reader.readByte());
		const serverPart = readString(reader.readByte());
		if (serverPart) {
			return `${userPart || ""}@${serverPart}`;
		}
		throw new Error(`invalid jid pair: ${userPart}, ${serverPart}`);
	};

	const readAdJid = () => {
		const agent = reader.readByte();
		const device = reader.readByte();
		const user = readString(reader.readByte());
		return jidEncode(user, agent === 0 ? "s.whatsapp.net" : "lid", device);
	};

	const readString = (tag: number): string => {
		if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
			return SINGLE_BYTE_TOKENS[tag] || "";
		}
		switch (tag) {
			case TAGS.DICTIONARY_0:
			case TAGS.DICTIONARY_1:
			case TAGS.DICTIONARY_2:
			case TAGS.DICTIONARY_3:
				return getTokenDouble(tag - TAGS.DICTIONARY_0, reader.readByte());
			case TAGS.LIST_EMPTY:
				return "";
			case TAGS.BINARY_8:
				return reader.readString(reader.readByte());
			case TAGS.BINARY_20:
				return reader.readString(reader.readInt20());
			case TAGS.BINARY_32:
				return reader.readString(reader.readInt(4));
			case TAGS.JID_PAIR:
				return readJidPair();
			case TAGS.AD_JID:
				return readAdJid();
			case TAGS.HEX_8:
			case TAGS.NIBBLE_8:
				return readPacked8(tag);
			default:
				throw new Error(`invalid string with tag: ${tag}`);
		}
	};

	const readList = (tag: number) => {
		const items: BinaryNode[] = [];
		const size = readListSize(tag);
		for (let i = 0; i < size; i++) {
			items.push(decodeDecompressedBinaryNode(reader));
		}
		return items;
	};

	const getTokenDouble = (index1: number, index2: number) => {
		const dict = DOUBLE_BYTE_TOKENS[index1];
		if (!dict) throw new Error(`Invalid double token dict (${index1})`);
		const value = dict[index2];
		if (typeof value === "undefined")
			throw new Error(`Invalid double token (${index2})`);
		return value;
	};

	const listSize = readListSize(reader.readByte());
	const tag = readString(reader.readByte());

	if (!listSize || !tag.length) throw new Error("invalid node");

	const attrs: BinaryNode["attrs"] = {};
	let content: BinaryNode["content"];

	const attributesLength = (listSize - 1) >> 1;
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(reader.readByte());
		const value = readString(reader.readByte());
		attrs[key] = value;
	}

	if (listSize % 2 === 0) {
		const tag = reader.readByte();
		if (isListTag(tag)) {
			content = readList(tag);
		} else {
			let decoded: Uint8Array | string;
			switch (tag) {
				case TAGS.BINARY_8:
					decoded = reader.readBytes(reader.readByte());
					break;
				case TAGS.BINARY_20:
					decoded = reader.readBytes(reader.readInt20());
					break;
				case TAGS.BINARY_32:
					decoded = reader.readBytes(reader.readInt(4));
					break;
				default:
					decoded = readString(tag);
					break;
			}
			content = decoded;
		}
	}

	return {
		tag: tag as SINGLE_BYTE_TOKENS_TYPE,
		attrs,
		content,
	};
};

export const decodeBinaryNode = (encodedBuffer: Uint8Array): BinaryNode => {
	const decompressedBuffer = decompressingIfRequired(encodedBuffer);
	const reader = new BinaryReader(decompressedBuffer);
	const decodedNode = decodeDecompressedBinaryNode(reader);

	return decodedNode;
};
