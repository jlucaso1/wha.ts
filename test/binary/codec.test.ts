import { expect, test } from "bun:test";
import type { BinaryNode } from "../../src/binary/types";
import { encodeBinaryNode } from "../../src/binary/encode";
import { decodeBinaryNode } from "../../src/binary/decode";

const nodeCases: {
  description: string;
  node: BinaryNode;
  encodedHex?: string;
}[] = [
  {
    description: "Whatsapp result send",
    node: {
      tag: "iq",
      attrs: {
        to: "@s.whatsapp.net",
        type: "result",
        id: "1678549119",
      },
    },
  },
];

test.each(nodeCases)("Encode/Decode: $description", async ({ node }) => {
  const encoded = encodeBinaryNode(node);
  const decoded = await decodeBinaryNode(encoded);

  expect(decoded).toEqual(node);
});
