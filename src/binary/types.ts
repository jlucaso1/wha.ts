import type { SINGLE_BYTE_TOKENS_TYPE } from './constants';

export type BinaryNode = {
  tag: SINGLE_BYTE_TOKENS_TYPE;
  attrs: { [key: string]: string };
  content?: BinaryNode[] | string | Uint8Array;
};