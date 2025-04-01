// src/binary/node-utils.ts
import type { BinaryNode } from "./types";

/**
 * Safely retrieves the first child node with a specific tag.
 * @param node The parent BinaryNode or undefined.
 * @param childTag The tag name of the child node to find.
 * @returns The found BinaryNode or undefined if not found or parent/content is invalid.
 */
export const getBinaryNodeChild = (
  node: BinaryNode | undefined,
  childTag: string
): BinaryNode | undefined => {
  if (node && Array.isArray(node.content)) {
    return node.content.find((item) => item.tag === childTag);
  }
  return undefined;
};

/**
 * Safely retrieves all child nodes with a specific tag.
 * @param node The parent BinaryNode or undefined.
 * @param childTag The tag name of the child nodes to find.
 * @returns An array of matching BinaryNodes, or an empty array if none found or parent/content is invalid.
 */
export const getBinaryNodeChildren = (
  node: BinaryNode | undefined,
  childTag: string
): BinaryNode[] => {
  if (node && Array.isArray(node.content)) {
    return node.content.filter((item) => item.tag === childTag);
  }
  return [];
};

/**
 * Safely retrieves the content of the first child node with a specific tag.
 * @param node The parent BinaryNode or undefined.
 * @param childTag The tag name of the child node.
 * @returns The content (BinaryNode[], string, Uint8Array, Buffer) or undefined.
 */
export const getBinaryNodeChildContent = (
  node: BinaryNode | undefined,
  childTag: string
): BinaryNode["content"] | undefined => {
  return getBinaryNodeChild(node, childTag)?.content;
};

/**
 * Safely retrieves the content of the first child node with a specific tag,
 * ensuring it's a string.
 * @param node The parent BinaryNode or undefined.
 * @param childTag The tag name of the child node.
 * @returns The string content, or undefined if not found or not a string/buffer.
 */
export const getBinaryNodeChildString = (
  node: BinaryNode | undefined,
  childTag: string
): string | undefined => {
  const content = getBinaryNodeChildContent(node, childTag);
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return Buffer.from(content).toString("utf-8");
  } else if (typeof content === "string") {
    return content;
  }
  return undefined;
};

/**
 * Safely retrieves the content of the first child node with a specific tag,
 * ensuring it's a Buffer.
 * @param node The parent BinaryNode or undefined.
 * @param childTag The tag name of the child node.
 * @returns The Buffer content, or undefined if not found or not a buffer/Uint8Array.
 */
export const getBinaryNodeChildBuffer = (
  node: BinaryNode | undefined,
  childTag: string
): Buffer | undefined => {
  const content = getBinaryNodeChildContent(node, childTag);
  if (Buffer.isBuffer(content)) {
    return content;
  } else if (content instanceof Uint8Array) {
    return Buffer.from(content); // Convert Uint8Array to Buffer
  }
  return undefined;
};
