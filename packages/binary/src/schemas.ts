import { ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";
import { NON_STANDARD_TAGS, SINGLE_BYTE_TOKENS } from "./constants";

export const BinaryNodeSchema = z.object({
	tag: z.enum(SINGLE_BYTE_TOKENS).or(z.enum(NON_STANDARD_TAGS)),
	attrs: z.record(z.string(), z.string()),

	get content() {
		return z
			.union([z.array(BinaryNodeSchema), z.string(), ZodUint8Array])
			.optional();
	},
});
