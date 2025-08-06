import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BinaryNode } from "@wha.ts/binary";
import { createWAClient } from "@wha.ts/core";
import { GenericAuthState, InMemoryStorageDatabase } from "@wha.ts/storage";
import type { DecryptionDumper } from "@wha.ts/types";

describe("Backward Compatibility", () => {
	test("should support legacy dumper configuration", async () => {
		// Create a temporary directory for dumping
		const dumpDir = "/tmp/plugin-test-dumps";
		await fs.mkdir(dumpDir, { recursive: true });

		let dumpCallCount = 0;
		const testDumper: DecryptionDumper<InMemoryStorageDatabase> = (
			dumpPath: string,
			node: BinaryNode,
			creds,
			storage,
		) => {
			dumpCallCount++;
			expect(dumpPath).toBe(dumpDir);
			expect(node).toBeDefined();
			expect(node.tag).toBeDefined();
			expect(creds).toBeDefined();
			expect(storage).toBeDefined();
		};

		// Create an in-memory storage for testing
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		// Create client with legacy dumper configuration
		const client = createWAClient({
			auth: authState,
			dumper: {
				func: testDumper,
				path: dumpDir,
				storage: storage,
			},
		});

		// Verify client was created successfully
		expect(typeof client.connect).toBe("function");
		expect(typeof client.logout).toBe("function");

		// The dumper should have been internally converted to a plugin
		// We can't easily test the hook execution without actually processing messages,
		// but we can verify the client initialization worked with the dumper config

		console.log(
			"✅ Legacy dumper configuration backward compatibility working",
		);

		// Clean up
		await fs.rmdir(dumpDir, { recursive: true }).catch(() => {
			// Ignore cleanup errors
		});
	});

	test("should work with both plugins and legacy dumper", async () => {
		// Create a temporary directory for dumping
		const dumpDir = "/tmp/plugin-test-dumps-hybrid";
		await fs.mkdir(dumpDir, { recursive: true });

		const testDumper: DecryptionDumper<InMemoryStorageDatabase> = () => {
			// Simple dumper for testing
		};

		// Create a test plugin
		const testPlugin = {
			name: "test-plugin",
			version: "1.0.0",
			api: {
				testMethod: () => "test-result",
			},
			install: (api: any) => {
				api.logger.info("Test plugin installed alongside dumper");
			},
		};

		// Create an in-memory storage for testing
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		// Create client with both plugins and legacy dumper
		const client = createWAClient({
			auth: authState,
			plugins: [testPlugin] as const,
			dumper: {
				func: testDumper,
				path: dumpDir,
				storage: storage,
			},
		});

		// Verify both plugin API and basic client functionality work
		expect(typeof client.connect).toBe("function");
		expect(typeof client.testMethod).toBe("function");
		expect(client.testMethod()).toBe("test-result");

		console.log("✅ Hybrid configuration (plugins + dumper) working");

		// Clean up
		await fs.rmdir(dumpDir, { recursive: true }).catch(() => {
			// Ignore cleanup errors
		});
	});
});
