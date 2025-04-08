export type BinaryNode = {
  tag: string;
  attrs: { [key: string]: string };
  content?: BinaryNode[] | string | Uint8Array;
};
