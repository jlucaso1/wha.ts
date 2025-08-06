import { describe, expect, test } from "bun:test";
import { createWAClient } from "@wha.ts/core";
import { GenericAuthState, InMemoryStorageDatabase } from "@wha.ts/storage";
import type { IPlugin } from "@wha.ts/types";

describe("Plugin System", () => {
	test("should support type-safe plugin API extension", async () => {
		// Create a simple statistics plugin for testing
		interface StatsAPI {
			getStats(): { incoming: number; outgoing: number };
		}

		const statisticsPlugin: IPlugin<StatsAPI> = {
			name: "statistics-plugin",
			version: "1.0.0",
			api: {
				getStats: () => ({
					incoming: statsCounter.incoming,
					outgoing: statsCounter.outgoing,
				}),
			},
			install: (api) => {
				// Listen to events and increment counters
				api.on("message.received", () => {
					statsCounter.incoming++;
				});

				api.on("node.sent", () => {
					statsCounter.outgoing++;
				});

				api.logger.info("Statistics plugin installed successfully");
			},
		};

		// Stats counter to be used by the plugin
		const statsCounter = { incoming: 0, outgoing: 0 };

		// Create an in-memory storage for testing
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		// Create client with the statistics plugin
		const client = createWAClient({
			auth: authState,
			plugins: [statisticsPlugin] as const,
		});

		// Verify that the client has the plugin API merged
		expect(typeof client.getStats).toBe("function");

		// Verify initial stats
		const initialStats = client.getStats();
		expect(initialStats).toEqual({ incoming: 0, outgoing: 0 });

		// Test that the plugin API returns the expected structure
		expect(typeof initialStats.incoming).toBe("number");
		expect(typeof initialStats.outgoing).toBe("number");

		console.log(
			"✅ Plugin system test passed - type-safe API extension working",
		);
	});

	test("should work without plugins", async () => {
		// Create an in-memory storage for testing
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		// Create client without plugins
		const client = createWAClient({
			auth: authState,
		});

		// Basic client functionality should still work
		expect(typeof client.connect).toBe("function");
		expect(typeof client.logout).toBe("function");
		expect(typeof client.sendTextMessage).toBe("function");

		// Plugin API should not exist
		expect((client as any).getStats).toBeUndefined();

		console.log("✅ Client without plugins works correctly");
	});

	test("should support multiple plugins", async () => {
		// Create two different plugins
		const plugin1: IPlugin<{ feature1: () => string }> = {
			name: "plugin1",
			version: "1.0.0",
			api: {
				feature1: () => "plugin1-result",
			},
			install: (api) => {
				api.logger.info("Plugin 1 installed");
			},
		};

		const plugin2: IPlugin<{ feature2: () => string }> = {
			name: "plugin2",
			version: "1.0.0",
			api: {
				feature2: () => "plugin2-result",
			},
			install: (api) => {
				api.logger.info("Plugin 2 installed");
			},
		};

		// Create an in-memory storage for testing
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		// Create client with multiple plugins
		const client = createWAClient({
			auth: authState,
			plugins: [plugin1, plugin2] as const,
		});

		// Both plugin APIs should be available
		expect(typeof client.feature1).toBe("function");
		expect(typeof client.feature2).toBe("function");

		expect(client.feature1()).toBe("plugin1-result");
		expect(client.feature2()).toBe("plugin2-result");

		console.log("✅ Multiple plugins working correctly");
	});
});
