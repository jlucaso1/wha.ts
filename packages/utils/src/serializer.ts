import { parse, stringify } from "devalue";

export const serializer = stringify;
export const deserializer = parse;
