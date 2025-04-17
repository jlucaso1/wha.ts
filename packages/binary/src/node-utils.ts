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
