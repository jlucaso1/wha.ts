import { Buffer } from "node:buffer";
import { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } from "./constants";
import { jidEncode } from "./jid-utils";
import type { BinaryNode } from "./types";

class DecodeError extends Error {
  constructor(
    message: string,
    public readonly partialNode?: Partial<BinaryNode>,
    public readonly bufferOffset?: number
  ) {
    super(message);
    this.name = "DecodeError";
  }
}

/**
 * Decodes the given buffer into a BinaryNode.
 * This function assumes the input buffer is *not* compressed.
 * Compression should be handled before calling this.
 */
export const decodeBinaryNode = (buffer: Uint8Array): BinaryNode => {
  const indexRef = { index: 0 };
  try {
    const node = decodeBinaryNodeContent(buffer, indexRef);
    if (indexRef.index < buffer.length) {
      // Optional: Could log or warn about trailing data, but often expected (e.g., message padding)
      // console.warn(`decodeBinaryNode finished with ${buffer.length - indexRef.index} bytes remaining`);
    }
    return node;
  } catch (error: any) {
    const partialNode =
      error instanceof DecodeError ? error.partialNode : undefined;
    const offset =
      error instanceof DecodeError ? error.bufferOffset : indexRef.index;
    console.error(
      `Binary decoding error at offset ${offset}: ${error.message}`,
      error.stack,
      partialNode
    );
    // Re-throw or handle as needed
    throw new DecodeError(
      `Decoding failed at offset ${offset}: ${error.message}`,
      partialNode,
      offset
    );
  }
};

// Internal function to handle the actual decoding logic
const decodeBinaryNodeContent = (
  buffer: Uint8Array,
  indexRef: { index: number }
): BinaryNode => {
  // --- Helper Functions ---
  const checkEOS = (length: number, partialNode?: Partial<BinaryNode>) => {
    if (indexRef.index + length > buffer.length) {
      throw new DecodeError("End of stream", partialNode, indexRef.index);
    }
  };

  const next = (): number => {
    const value = buffer[indexRef.index];
    indexRef.index += 1;

    if (value === undefined) {
      throw new DecodeError(
        "Unexpected end of stream",
        undefined,
        indexRef.index
      );
    }

    return value;
  };

  const readByte = (partialNode?: Partial<BinaryNode>) => {
    checkEOS(1, partialNode);
    return next();
  };

  const readBytes = (n: number, partialNode?: Partial<BinaryNode>) => {
    checkEOS(n, partialNode);
    const value = buffer.subarray(indexRef.index, indexRef.index + n);
    indexRef.index += n;
    return value;
  };

  const readStringFromChars = (
    length: number,
    partialNode?: Partial<BinaryNode>
  ) => {
    return Buffer.from(readBytes(length, partialNode)).toString("utf-8");
  };

  const readInt = (
    n: number,
    littleEndian = false,
    partialNode?: Partial<BinaryNode>
  ): number => {
    checkEOS(n, partialNode);
    let val = 0;
    for (let i = 0; i < n; i++) {
      const shift = littleEndian ? i : n - 1 - i;
      // ShiftHandling: Use Math.pow for potentially large shifts if needed, but direct shift is fine for < 32 bits
      val |= next() << (shift * 8);
    }
    // Use unsigned right shift for potential negative results if reading as signed
    return val >>> 0;
  };

  const readInt16 = (littleEndian = false, partialNode?: Partial<BinaryNode>) =>
    readInt(2, littleEndian, partialNode);
  const readInt20 = (partialNode?: Partial<BinaryNode>): number => {
    checkEOS(3, partialNode);
    // Bitwise operations for efficiency
    return ((next() & 0x0f) << 16) + (next() << 8) + next();
  };
  const readInt32 = (littleEndian = false, partialNode?: Partial<BinaryNode>) =>
    readInt(4, littleEndian, partialNode);

  const unpackNibble = (value: number): number => {
    // 0-9 maps to '0'-'9' ASCII codes (48-57)
    if (value >= 0 && value <= 9) return 48 + value;
    // 10 maps to '-' ASCII code (45)
    if (value === 10) return 45;
    // 11 maps to '.' ASCII code (46)
    if (value === 11) return 46;
    // 15 maps to '\0' (often represents end/null, though context matters) - Return 0 for null char
    if (value === 15) return 0;

    throw new DecodeError(
      `Invalid nibble value: ${value}`,
      undefined,
      indexRef.index
    );
  };

  const unpackHex = (value: number): number => {
    // 0-9 maps to '0'-'9' ASCII (48-57)
    if (value >= 0 && value <= 9) return 48 + value;
    // 10-15 maps to 'A'-'F' ASCII (65-70)
    if (value >= 10 && value <= 15) return 65 + (value - 10);

    throw new DecodeError(
      `Invalid hex value: ${value}`,
      undefined,
      indexRef.index
    );
  };

  const unpackByte = (tag: number, value: number): number => {
    if (tag === TAGS.NIBBLE_8) return unpackNibble(value);
    if (tag === TAGS.HEX_8) return unpackHex(value);
    throw new DecodeError(
      `Unknown packed type tag: ${tag}`,
      undefined,
      indexRef.index
    );
  };

  const readPacked8 = (
    tag: number,
    partialNode?: Partial<BinaryNode>
  ): string => {
    const startByte = readByte(partialNode);
    if (startByte === undefined) {
      throw new DecodeError(
        "Failed to read start byte",
        partialNode,
        indexRef.index
      );
    }
    const length = startByte & 0x7f; // Mask out the highest bit to get length
    const isLastByteIncomplete = startByte >> 7 !== 0; // Check the highest bit

    if (length === 0) return ""; // Handle zero length case

    const chars: number[] = new Array(length * 2); // Preallocate array for performance

    for (let i = 0; i < length; i++) {
      const curByte = readByte(partialNode);
      if (curByte === undefined) {
        throw new DecodeError(
          "Failed to read byte",
          partialNode,
          indexRef.index
        );
      }
      // Unpack high nibble (first char) and low nibble (second char)
      chars[i * 2] = unpackByte(tag, (curByte & 0xf0) >> 4);
      chars[i * 2 + 1] = unpackByte(tag, curByte & 0x0f);
    }

    // If the last byte was incomplete (highest bit set), remove the last character (which would be from the '\x00' padding)
    const finalLength = isLastByteIncomplete ? chars.length - 1 : chars.length;

    // Filter out null characters resulting from unpackNibble(15) before creating string
    return String.fromCharCode(
      ...chars.slice(0, finalLength).filter((c): c is number => c !== 0)
    );
  };

  const isListTag = (tag: number): boolean => {
    return (
      tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
    );
  };

  const readListSize = (
    tag: number,
    partialNode?: Partial<BinaryNode>
  ): number => {
    switch (tag) {
      case TAGS.LIST_EMPTY:
        return 0;
      case TAGS.LIST_8:
        const size = readByte(partialNode);
        if (size === undefined) {
          throw new DecodeError(
            "Failed to read list size",
            partialNode,
            indexRef.index
          );
        }
        return size;
      case TAGS.LIST_16:
        return readInt16(false, partialNode); // WA uses Big Endian for list size
      default:
        throw new DecodeError(
          `Invalid list tag: ${tag}`,
          partialNode,
          indexRef.index
        );
    }
  };

  const readJidPair = (partialNode?: Partial<BinaryNode>): string => {
    const userTag = readByte(partialNode);
    if (userTag === undefined) {
      throw new DecodeError(
        "Failed to read JID user tag",
        partialNode,
        indexRef.index
      );
    }
    const user = readString(userTag, partialNode); // Read user part

    const serverTag = readByte(partialNode);
    if (serverTag === undefined) {
      throw new DecodeError(
        "Failed to read JID server tag",
        partialNode,
        indexRef.index
      );
    }
    const server = readString(serverTag, partialNode); // Read server part

    if (typeof server === "string" && server.length > 0) {
      return `${user}@${server}`;
    }
    // If server is empty/null (like LIST_EMPTY tag), it might be invalid or represent self JID in some contexts
    // Throwing error for safety, adjust if specific contexts allow empty server part.
    throw new DecodeError(
      `Invalid JID pair: user='${user}', server='${server}'`,
      partialNode,
      indexRef.index
    );
  };

  const readAdJid = (partialNode?: Partial<BinaryNode>): string => {
    // Ref: https://github.com/WhiskeySockets/Baileys/blob/master/src/WABinary/decode.ts#L151
    const agent = readByte(partialNode);
    if (agent === undefined) {
      throw new DecodeError(
        "Failed to read agent byte",
        partialNode,
        indexRef.index
      );
    }

    const device = readByte(partialNode);
    if (device === undefined) {
      throw new DecodeError(
        "Failed to read device byte",
        partialNode,
        indexRef.index
      );
    }

    const userTag = readByte(partialNode);
    if (userTag === undefined) {
      throw new DecodeError(
        "Failed to read user tag",
        partialNode,
        indexRef.index
      );
    }

    const user = readString(userTag, partialNode);
    // Encode using the utility function
    return jidEncode(user, agent === 0 ? "s.whatsapp.net" : "lid", device);
  };

  const readString = (
    tag: number,
    partialNode?: Partial<BinaryNode>
  ): string => {
    // Check if it's a single-byte token
    if (tag >= 3 && tag < TAGS.DICTIONARY_0) {
      // Adjusted range based on typical token usage
      const token = SINGLE_BYTE_TOKENS[tag];
      if (!token)
        throw new DecodeError(
          `Invalid single-byte token index: ${tag}`,
          partialNode,
          indexRef.index
        );
      return token;
    }

    switch (tag) {
      case TAGS.DICTIONARY_0:
      case TAGS.DICTIONARY_1:
      case TAGS.DICTIONARY_2:
      case TAGS.DICTIONARY_3:
        const dictIndex = tag - TAGS.DICTIONARY_0;
        const tokenIndex = readByte(partialNode);
        if (tokenIndex === undefined) {
          throw new DecodeError(
            "Failed to read token index",
            partialNode,
            indexRef.index
          );
        }
        const dict = DOUBLE_BYTE_TOKENS[dictIndex];
        if (!dict || tokenIndex >= dict.length) {
          throw new DecodeError(
            `Invalid double-byte token index: dict=${dictIndex}, token=${tokenIndex}`,
            partialNode,
            indexRef.index
          );
        }

        const token = dict[tokenIndex];
        if (!token)
          throw new DecodeError(
            `Invalid token for dictionary ${dictIndex} at index ${tokenIndex}`,
            partialNode,
            indexRef.index
          );

        return token;
      case TAGS.LIST_EMPTY:
        return ""; // Represents an empty string or list
      case TAGS.BINARY_8:
        const len1 = readByte(partialNode);
        if (len1 === undefined) {
          throw new DecodeError(
            "Failed to read binary length",
            partialNode,
            indexRef.index
          );
        }
        return readStringFromChars(len1, partialNode);
      case TAGS.BINARY_20:
        const len2 = readInt20(partialNode);
        if (len2 === undefined) {
          throw new DecodeError(
            "Failed to read binary length",
            partialNode,
            indexRef.index
          );
        }
        return readStringFromChars(len2, partialNode);
      case TAGS.BINARY_32:
        const len3 = readInt32(false, partialNode);
        if (len3 === undefined) {
          throw new DecodeError(
            "Failed to read binary length",
            partialNode,
            indexRef.index
          );
        }
        return readStringFromChars(len3, partialNode); // Assuming Big Endian length
      case TAGS.JID_PAIR:
        return readJidPair(partialNode);
      case TAGS.AD_JID:
        return readAdJid(partialNode);
      case TAGS.HEX_8:
        return readPacked8(TAGS.HEX_8, partialNode);
      case TAGS.NIBBLE_8:
        return readPacked8(TAGS.NIBBLE_8, partialNode);
      default:
        throw new DecodeError(
          `Invalid tag for string: ${tag}`,
          partialNode,
          indexRef.index
        );
    }
  };

  const readList = (
    tag: number,
    partialNode?: Partial<BinaryNode>
  ): BinaryNode[] => {
    const size = readListSize(tag, partialNode);
    const items: BinaryNode[] = new Array(size); // Preallocate array
    for (let i = 0; i < size; i++) {
      items[i] = decodeBinaryNodeContent(buffer, indexRef); // Recursively decode child nodes
    }
    return items;
  };

  // --- Main Decoding Logic ---

  const listSizeTag = readByte();
  if (listSizeTag === undefined) {
    throw new DecodeError(
      "Failed to read list size tag",
      undefined,
      indexRef.index
    );
  }

  const listSize = readListSize(listSizeTag);

  const descrTag = readByte();
  if (descrTag === undefined) {
    throw new DecodeError(
      "Failed to read description tag",
      undefined,
      indexRef.index
    );
  }

  if (descrTag === TAGS.STREAM_END) {
    throw new DecodeError("Unexpected stream end", undefined, indexRef.index);
  }

  const tag = readString(descrTag);
  const partialNode: Partial<BinaryNode> = { tag }; // For error reporting

  if (listSize === 0) {
    throw new DecodeError(
      `Invalid node, no list size for tag "${tag}"`,
      partialNode,
      indexRef.index
    );
  }

  const attrs: { [key: string]: string } = {};
  const attrsCount = (listSize - 1) >> 1; // Number of key-value attribute pairs

  for (let i = 0; i < attrsCount; i++) {
    const keyTag = readByte(partialNode);
    if (keyTag === undefined) {
      throw new DecodeError(
        "Failed to read attribute key tag",
        partialNode,
        indexRef.index
      );
    }

    const key = readString(keyTag, partialNode);

    partialNode.attrs = attrs; // Update partial node for potential errors in value reading

    const valueTag = readByte(partialNode);
    if (valueTag === undefined) {
      throw new DecodeError(
        "Failed to read attribute value tag",
        partialNode,
        indexRef.index
      );
    }

    const value = readString(valueTag, partialNode);
    attrs[key] = value;
  }
  partialNode.attrs = attrs; // Final attrs for error reporting if content fails

  let content: BinaryNode["content"];

  // If listSize is odd, the last element is the content
  if (listSize % 2 === 0) {
    const contentTag = readByte(partialNode);
    if (contentTag === undefined) {
      throw new DecodeError(
        "Failed to read content tag",
        partialNode,
        indexRef.index
      );
    }

    if (isListTag(contentTag)) {
      content = readList(contentTag, partialNode);
    } else {
      switch (contentTag) {
        case TAGS.BINARY_8:
          const len1 = readByte(partialNode);
          if (len1 === undefined) {
            throw new DecodeError(
              "Failed to read binary length",
              partialNode,
              indexRef.index
            );
          }
          content = readBytes(len1, partialNode);
          break;
        case TAGS.BINARY_20:
          const len2 = readInt20(partialNode);
          content = readBytes(len2, partialNode);
          break;
        case TAGS.BINARY_32:
          const len3 = readInt32(false, partialNode);
          content = readBytes(len3, partialNode);
          break;
        default:
          // Content is a string type
          const stringContent = readString(contentTag, partialNode);
          content = stringContent; // This ensures it's never undefined
          break;
      }
    }
  }

  return {
    tag,
    attrs,
    content,
  };
};
