import { bytesToUtf8 } from "../utils/bytes-utils";
import type { BinaryNode } from "./types";

export const getBinaryNodeChild = (
  node: BinaryNode | undefined,
  childTag: string,
): BinaryNode | undefined => {
  if (node && Array.isArray(node.content)) {
    return node.content.find((item) => item.tag === childTag);
  }
  return undefined;
};

export const getBinaryNodeChildren = (
  node: BinaryNode | undefined,
  childTag: string,
): BinaryNode[] => {
  if (node && Array.isArray(node.content)) {
    return node.content.filter((item) => item.tag === childTag);
  }
  return [];
};

export const getBinaryNodeChildContent = (
  node: BinaryNode | undefined,
  childTag: string,
): BinaryNode["content"] | undefined => {
  return getBinaryNodeChild(node, childTag)?.content;
};

export const getBinaryNodeChildString = (
  node: BinaryNode | undefined,
  childTag: string,
): string | undefined => {
  const content = getBinaryNodeChildContent(node, childTag);
  if (content instanceof Uint8Array) {
    return bytesToUtf8(content);
  } else if (typeof content === "string") {
    return content;
  }
  return undefined;
};

export const getBinaryNodeChildBuffer = (
  node: BinaryNode | undefined,
  childTag: string,
): Uint8Array | undefined => {
  const content = getBinaryNodeChildContent(node, childTag);

  if (content instanceof Uint8Array) {
    return content;
  }

  return undefined;
};

export async function decompressData(
  compressedData: Uint8Array,
): Promise<Uint8Array> {
  const readableStream = new ReadableStream({
    start(controller) {
      controller.enqueue(compressedData);
      controller.close();
    },
  });

  const decompressionStream = new DecompressionStream("deflate");

  const decompressedStream = readableStream.pipeThrough(decompressionStream);

  const response = new Response(decompressedStream);
  const decompressedArrayBuffer = await response.arrayBuffer();

  return new Uint8Array(decompressedArrayBuffer);
}
