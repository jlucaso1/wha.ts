import { expect, test } from "bun:test";
import { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import { encodeBinaryNode } from "@wha.ts/binary/src/encode";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import { hexToBytes } from "@wha.ts/utils/src/bytes-utils";

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

const dirtyNodeBuffer = hexToBytes(
	"00f804fc02696206fa0003f801f805ee2804ec85ec6dfc0a31373434333831303439",
);

const expectedDirtyNode: BinaryNode = {
	tag: "ib",
	attrs: {
		from: "@s.whatsapp.net",
	},
	content: [
		{
			tag: "dirty",
			attrs: {
				type: "account_sync",
				timestamp: "1744381049",
			},
			content: undefined,
		},
	],
};

test.each(nodeCases)("Encode/Decode: $description", ({ node }) => {
	const encoded = encodeBinaryNode(node);
	const decoded = decodeBinaryNode(encoded);

	expect(decoded).toEqual(node);
});

test("Decode: Dirty node", async () => {
	const decoded = decodeBinaryNode(dirtyNodeBuffer);

	console.log("a", decoded);
	expect(decoded).toEqual(expectedDirtyNode);
});
