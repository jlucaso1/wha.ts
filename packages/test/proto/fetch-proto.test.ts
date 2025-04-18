import { describe, expect, it } from "bun:test";
import { generateProto } from "@wha.ts/proto/scripts/fetch-proto";

describe("WAProto proto generation", () => {
	it("should generate the correct .proto schema string", async () => {
		const generatedProto = await generateProto();
		expect(generatedProto).toContain('syntax = "proto2";');
		expect(generatedProto).toContain("WhatsApp Version:");
	});
});
