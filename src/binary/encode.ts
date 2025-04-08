import { utf8ToBytes } from "../utils/bytes-utils";
import { TAGS, TOKEN_MAP } from "./constants";
import { type FullJid, jidDecode } from "./jid-utils";
import type { BinaryNode } from "./types";

const bufferList: number[] = [];

export const encodeBinaryNode = (node: BinaryNode): Uint8Array => {
  bufferList.length = 0;
  try {
    encodeBinaryNodeInternal(node, bufferList);
    return new Uint8Array([0x00, ...bufferList]);
  } catch (error) {
    console.error("Binary encoding error:", error);
    throw error;
  }
};

const encodeBinaryNodeInternal = (
  { tag, attrs, content }: BinaryNode,
  buffer: number[],
): void => {
  const pushByte = (value: number) => buffer.push(value & 0xff);

  const pushInt = (value: number, n: number, littleEndian = false) => {
    for (let i = 0; i < n; i++) {
      const curShift = littleEndian ? i : n - 1 - i;
      buffer.push((value >> (curShift * 8)) & 0xff);
    }
  };

  const pushBytes = (bytes: Uint8Array) => {
    Array.prototype.push.apply(buffer, Array.from(bytes));
  };

  const pushInt16 = (value: number) => {
    pushBytes(new Uint8Array([(value >> 8) & 0xff, value & 0xff]));
  };

  const pushInt20 = (value: number) =>
    pushBytes(
      new Uint8Array([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff]),
    );

  const pushInt32 = (value: number) => pushInt(value, 4, false);

  const writeByteLength = (length: number) => {
    if (length >= 1 << 20) {
      pushByte(TAGS.BINARY_32);
      pushInt32(length);
    } else if (length >= 256) {
      pushByte(TAGS.BINARY_20);
      pushInt20(length);
    } else {
      pushByte(TAGS.BINARY_8);
      pushByte(length);
    }
  };

  const writeStringRaw = (str: string) => {
    const bytes = utf8ToBytes(str);
    writeByteLength(bytes.length);
    pushBytes(bytes);
  };

  const writeJid = ({ user, server, device }: FullJid) => {
    if (typeof device === "number" || server === "lid") {
      pushByte(TAGS.AD_JID);
      pushByte(server === "lid" ? 1 : 0);
      pushByte(device || 0);
      writeString(user || "");
    } else {
      pushByte(TAGS.JID_PAIR);
      if (user?.length) {
        writeString(user);
      } else {
        pushByte(TAGS.LIST_EMPTY);
      }
      writeString(server);
    }
  };

  const writeString = (str: string | undefined | null) => {
    if (str === null || str === undefined) {
      pushByte(TAGS.LIST_EMPTY);
      return;
    }

    const tokenData = TOKEN_MAP[str];
    if (tokenData) {
      if (typeof tokenData.dict === "number") {
        pushByte(TAGS.DICTIONARY_0 + tokenData.dict);
      }
      pushByte(tokenData.index);
    } else {
      const jid = jidDecode(str);
      if (jid) {
        writeJid(jid);
      } else {
        writeStringRaw(str);
      }
    }
  };

  const writeListStart = (listSize: number) => {
    if (listSize === 0) {
      pushByte(TAGS.LIST_EMPTY);
    } else if (listSize < 256) {
      pushByte(TAGS.LIST_8);
      pushByte(listSize);
    } else {
      pushByte(TAGS.LIST_16);
      pushInt16(listSize);
    }
  };

  const validAttributes = Object.keys(attrs).filter(
    (k) => attrs[k] !== undefined && attrs[k] !== null,
  );

  const listSize = 1 + 2 * validAttributes.length +
    (content !== undefined ? 1 : 0);
  writeListStart(listSize);
  writeString(tag);

  for (const key of validAttributes) {
    writeString(key);
    writeString(attrs[key]);
  }

  if (typeof content === "string") {
    writeString(content);
  } else if (content instanceof Uint8Array) {
    writeByteLength(content.length);
    pushBytes(content);
  } else if (Array.isArray(content)) {
    writeListStart(content.length);
    for (const item of content) {
      encodeBinaryNodeInternal(item, buffer);
    }
  } else if (typeof content === "undefined") {
    // do nothing
  } else {
    throw new Error(
      `Cannot encode content of type ${typeof content}: ${content}`,
    );
  }
};
