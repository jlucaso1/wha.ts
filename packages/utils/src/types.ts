import type { z } from "zod/v4";
import type { KeyPairSchema, SignedKeyPairSchema } from "./schemas";

export type KeyPair = z.infer<typeof KeyPairSchema>;

export type SignedKeyPair = z.infer<typeof SignedKeyPairSchema>;
