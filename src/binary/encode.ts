import { Buffer } from "node:buffer";
import { TAGS, TOKEN_MAP } from "./constants"; // Use our constants
import { jidDecode, type FullJid } from "./jid-utils";
import type { BinaryNode } from "./types";

// Reusable buffer array for encoding process
const bufferList: number[] = [];

/**
 * Encodes a BinaryNode into a Buffer.
 * This is the primary function to convert the structured node back to bytes.
 */
export const encodeBinaryNode = (node: BinaryNode): Buffer => {
  bufferList.length = 0; // Reset the buffer list for each encoding run
  try {
    encodeBinaryNodeInternal(node, bufferList);
    return Buffer.from(bufferList);
  } catch (error) {
    console.error("Binary encoding error:", error);
    // Decide on error handling - throw, return empty buffer, etc.
    throw error; // Re-throwing for now
  }
};

// Internal recursive function for encoding
const encodeBinaryNodeInternal = (
  { tag, attrs, content }: BinaryNode,
  buffer: number[] // Pass buffer array for performance
): void => {
  // --- Helper Functions ---
  const pushByte = (value: number) => buffer.push(value & 0xff);

  const pushInt = (value: number, n: number, littleEndian = false) => {
    for (let i = 0; i < n; i++) {
      const curShift = littleEndian ? i : n - 1 - i;
      buffer.push((value >> (curShift * 8)) & 0xff);
    }
  };

  const pushBytes = (bytes: Uint8Array) => {
    // Using Buffer.from().forEach() might be slightly less performant than a simple loop
    // for (const b of bytes) buffer.push(b);
    // Optimized push using Array.prototype.push.apply
    Array.prototype.push.apply(buffer, Array.from(bytes));
  };

  const pushInt16 = (value: number) => {
    // WA uses Big Endian for Int16
    pushBytes(Buffer.from([(value >> 8) & 0xff, value & 0xff]));
  };

  const pushInt20 = (value: number) =>
    // WA uses Big Endian for Int20 (special 3-byte int)
    pushBytes(
      Buffer.from([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff])
    );

  const pushInt32 = (value: number) => pushInt(value, 4, false); // WA uses Big Endian

  const writeByteLength = (length: number) => {
    if (length >= 1 << 20) {
      // Use 1 << 20 for clarity (2^20)
      pushByte(TAGS.BINARY_32);
      pushInt32(length); // 32-bit length (4 bytes)
    } else if (length >= 256) {
      pushByte(TAGS.BINARY_20);
      pushInt20(length); // 20-bit length (3 bytes)
    } else {
      pushByte(TAGS.BINARY_8);
      pushByte(length); // 8-bit length (1 byte)
    }
  };

  const writeStringRaw = (str: string) => {
    const bytes = Buffer.from(str, "utf-8");
    writeByteLength(bytes.length);
    pushBytes(bytes);
  };

  const writeJid = ({ user, server, device }: FullJid) => {
    // AD JID (Agent/Device JID) - Seems less common now, but included from Baileys
    // if(typeof agent === 'number' || typeof device === 'number') {
    if (typeof device === "number" || server === "lid") {
      // Lid also uses AD JID structure apparently
      pushByte(TAGS.AD_JID);
      pushByte(server === "lid" ? 1 : 0); // domainType: 0 for s.whatsapp.net, 1 for lid
      pushByte(device || 0);
      writeString(user || ""); // User can be empty? Baileys logic allows this.
    } else {
      // Standard JID Pair
      pushByte(TAGS.JID_PAIR);
      if (user?.length) {
        writeString(user);
      } else {
        pushByte(TAGS.LIST_EMPTY); // User part is empty
      }
      writeString(server); // Server part
    }
  };

  // Implementations for packed nibble/hex (less common, maybe skip for MVP?)
  // const packNibble = ...
  // const packHex = ...
  // const writePackedBytes = ...
  // const isNibble = ...
  // const isHex = ...

  const writeString = (str: string | undefined | null) => {
    if (str === null || str === undefined) {
      // Represent null/undefined string, often with LIST_EMPTY or a specific tag if applicable
      // Using LIST_EMPTY as a general placeholder based on Baileys JID pair logic
      pushByte(TAGS.LIST_EMPTY);
      return;
    }

    const tokenData = TOKEN_MAP[str];
    if (tokenData) {
      // Is it a double-byte token?
      if (typeof tokenData.dict === "number") {
        pushByte(TAGS.DICTIONARY_0 + tokenData.dict);
      }
      // Push the index
      pushByte(tokenData.index);
    } else {
      // Try encoding as JID first
      const jid = jidDecode(str);
      if (jid) {
        writeJid(jid);
      }
      // else if (isNibble(str)) { writePackedBytes(str, 'nibble'); } // Optional
      // else if (isHex(str)) { writePackedBytes(str, 'hex'); } // Optional
      else {
        // Otherwise, write as raw binary string
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
      pushInt16(listSize); // Ensure correct endianness if needed (WA uses BE)
    }
  };

  // --- Main Encoding Logic ---

  // Filter out undefined/null attributes
  const validAttributes = Object.keys(attrs).filter(
    (k) => attrs[k] !== undefined && attrs[k] !== null
  );

  // Calculate list size: 1 for tag + 2 for each attribute pair + 1 if content exists
  const listSize =
    1 + 2 * validAttributes.length + (content !== undefined ? 1 : 0);
  writeListStart(listSize);
  writeString(tag);

  // Write attributes
  for (const key of validAttributes) {
    writeString(key);
    writeString(attrs[key]); // Assumes attributes are always strings
  }

  // Write content
  if (typeof content === "string") {
    writeString(content);
  } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    writeByteLength(content.length);
    pushBytes(content);
  } else if (Array.isArray(content)) {
    writeListStart(content.length);
    for (const item of content) {
      encodeBinaryNodeInternal(item, buffer); // Recursive call for child nodes
    }
  } else if (content === undefined || content === null) {
    // Do nothing, absence already indicated by list size
  } else {
    throw new Error(
      `Cannot encode content of type ${typeof content}: ${content}`
    );
  }
};
