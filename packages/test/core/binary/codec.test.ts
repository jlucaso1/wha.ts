import { expect, test } from "bun:test";
import { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import { encodeBinaryNode } from "@wha.ts/binary/src/encode";
import type { BinaryNode } from "@wha.ts/binary/src/types";

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
