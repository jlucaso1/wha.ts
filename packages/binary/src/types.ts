import type z from "zod";
import type { BinaryNodeSchema } from "./schemas";

export type BinaryNode = z.infer<typeof BinaryNodeSchema>;
