export type BinaryNode = {
  tag: string;
  attrs: { [key: string]: string };
  content?: BinaryNode[] | string | Uint8Array;
};

export type BinaryNodeAttributes = BinaryNode["attrs"];
export type BinaryNodeData = BinaryNode["content"];
