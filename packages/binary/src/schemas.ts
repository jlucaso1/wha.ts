import { ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";
import {
	DOUBLE_BYTE_TOKENS,
	NON_STANDARD_TAGS,
	SINGLE_BYTE_TOKENS,
} from "./constants";

export const BinaryNodeSchema = z.object({
	attrs: z.record(z.string(), z.string()),

	get content() {
		return z
			.union([z.array(BinaryNodeSchema), z.string(), ZodUint8Array])
			.optional();
	},
	tag: z
		.enum(SINGLE_BYTE_TOKENS)
		.or(
			z
				.enum(DOUBLE_BYTE_TOKENS[0])
				.or(z.enum(DOUBLE_BYTE_TOKENS[1]))
				.or(z.enum(DOUBLE_BYTE_TOKENS[2]))
				.or(z.enum(DOUBLE_BYTE_TOKENS[3])),
		)
		.or(z.enum(NON_STANDARD_TAGS)),
});
