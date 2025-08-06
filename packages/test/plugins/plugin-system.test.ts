import { describe, expect, test } from "bun:test";
import { createWAClient } from "@wha.ts/core";
import { GenericAuthState, InMemoryStorageDatabase } from "@wha.ts/storage";
import type { IPlugin } from "@wha.ts/types";

describe("Plugin System", () => {
	test("should support type-safe plugin API extension", async () => {
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
				api.on("message.received", () => {
					statsCounter.incoming++;
				});

				api.on("node.sent", () => {
					statsCounter.outgoing++;
				});

				api.logger.info("Statistics plugin installed successfully");
			},
		};

		const statsCounter = { incoming: 0, outgoing: 0 };

		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		const client = createWAClient({
			auth: authState,
			plugins: [statisticsPlugin] as const,
		});

		expect(typeof client.getStats).toBe("function");

		const initialStats = client.getStats();
		expect(initialStats).toEqual({ incoming: 0, outgoing: 0 });

		expect(typeof initialStats.incoming).toBe("number");
		expect(typeof initialStats.outgoing).toBe("number");

		console.log(
			"✅ Plugin system test passed - type-safe API extension working",
		);
	});

	test("should work without plugins", async () => {
		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		const client = createWAClient({
			auth: authState,
		});

		expect(typeof client.connect).toBe("function");
		expect(typeof client.logout).toBe("function");
		expect(typeof client.sendTextMessage).toBe("function");

		expect((client as any).getStats).toBeUndefined();

		console.log("✅ Client without plugins works correctly");
	});

	test("should support multiple plugins", async () => {
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

		const storage = new InMemoryStorageDatabase();
		const authState = await GenericAuthState.init(storage);

		const client = createWAClient({
			auth: authState,
			plugins: [plugin1, plugin2] as const,
		});

		expect(typeof client.feature1).toBe("function");
		expect(typeof client.feature2).toBe("function");

		expect(client.feature1()).toBe("plugin1-result");
		expect(client.feature2()).toBe("plugin2-result");

		console.log("✅ Multiple plugins working correctly");
	});
});
