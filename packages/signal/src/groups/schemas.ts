import { ZodUint8Array } from "@wha.ts/utils/schemas";
import { z } from "zod/v4";

export const SenderChainKeySchema = z.object({
	iteration: z.number(),
	seed: ZodUint8Array,
});

export const SenderMessageKeySchema = z.object({
	iteration: z.number(),
	seed: ZodUint8Array,
});

export const SenderSigningKeySchema = z.object({
	public: ZodUint8Array,
	private: ZodUint8Array.optional(),
});

export const SenderKeyStateSchema = z.object({
	senderKeyId: z.number(),
	senderChainKey: SenderChainKeySchema,
	senderSigningKey: SenderSigningKeySchema,
	senderMessageKeys: z.array(SenderMessageKeySchema).default([]),
});
export type SenderKeyState = z.infer<typeof SenderKeyStateSchema>;

export const SenderKeyRecordSchema = z.object({
	senderKeyStates: z.array(SenderKeyStateSchema).default([]),
});
export type SenderKeyRecord = z.infer<typeof SenderKeyRecordSchema>;
