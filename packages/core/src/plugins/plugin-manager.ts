import type { BinaryNode } from "@wha.ts/binary";
import type {
	AuthenticationCreds,
	DeepReadonly,
	IPlugin,
	PluginAPI,
} from "@wha.ts/types";
import type { ClientEventMap } from "../client-events";
import type { ILogger } from "../transport/types";

// Forward reference to avoid circular dependency
interface WhaTSClientLike {
	auth: { creds: AuthenticationCreds };
	logger: ILogger;
	sendTextMessage(
		jid: string,
		text: string,
	): Promise<{ messageId: string; ack?: BinaryNode; error?: string }>;
	sendPresenceUpdate(
		type: "available" | "unavailable" | "composing" | "paused",
		toJid?: string,
	): Promise<void>;
	addListener<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void;
}

/**
 * Internal class responsible for managing plugins.
 * This class should NOT be exported from the package's public API.
 */
export class PluginManager {
	private plugins: readonly IPlugin[];
	private client: WhaTSClientLike;
	private preDecryptCallbacks: ((node: BinaryNode) => void)[] = [];

	constructor(client: WhaTSClientLike, plugins: readonly IPlugin[] = []) {
		this.client = client;
		this.plugins = plugins;
	}

	/**
	 * Install all plugins by calling their install() method with the sandboxed API handle
	 */
	public installAll(): void {
		for (const plugin of this.plugins) {
			try {
				const sandboxedAPI = this.createSandboxedAPI();
				plugin.install(sandboxedAPI);
				this.client.logger.info(
					{ pluginName: plugin.name, pluginVersion: plugin.version },
					"Plugin installed successfully",
				);
			} catch (error) {
				this.client.logger.error(
					{
						err: error,
						pluginName: plugin.name,
						pluginVersion: plugin.version,
					},
					"Failed to install plugin",
				);
			}
		}
	}

	/**
	 * Get aggregated APIs from all plugins to merge with client instance
	 */
	public getExposedApis(): Record<string, any> {
		const aggregatedAPI: Record<string, any> = {};

		for (const plugin of this.plugins) {
			if (plugin.api) {
				Object.assign(aggregatedAPI, plugin.api);
			}
		}

		return aggregatedAPI;
	}

	/**
	 * Get all registered pre-decrypt callbacks for the MessageProcessor
	 */
	public getPreDecryptTaps(): ((node: BinaryNode) => void)[] {
		return [...this.preDecryptCallbacks];
	}

	/**
	 * Create a sandboxed API handle for a plugin
	 */
	private createSandboxedAPI(): PluginAPI {
		return {
			// 1. Data Access (Read-Only)
			getAuthState: (): DeepReadonly<AuthenticationCreds> => {
				// Return a deep readonly version of the auth state
				return this.deepFreeze(this.client.auth.creds);
			},

			// 2. Core Actions (Write/Perform)
			actions: {
				sendTextMessage: (jid: string, text: string) =>
					this.client.sendTextMessage(jid, text),
				sendPresenceUpdate: (
					type: "available" | "unavailable" | "composing" | "paused",
					toJid?: string,
				) => this.client.sendPresenceUpdate(type, toJid),
			},

			// 3. Event Bus (Listen)
			on: <K extends keyof ClientEventMap>(
				event: K,
				listener: (data: ClientEventMap[K]) => void,
			) => {
				this.client.addListener(event, listener);
			},

			// 4. Lifecycle Hooks (Tap-in)
			hooks: {
				onPreDecrypt: {
					tap: (callback: (node: BinaryNode) => void) => {
						this.preDecryptCallbacks.push(callback);
					},
				},
			},

			// 5. Utilities
			logger: this.client.logger,
		};
	}

	/**
	 * Deep freeze an object to make it truly readonly
	 */
	private deepFreeze<T>(obj: T): DeepReadonly<T> {
		// Get property names
		const propNames = Object.getOwnPropertyNames(obj);

		// Freeze properties before freezing self
		for (const name of propNames) {
			const value = (obj as any)[name];
			if (value && typeof value === "object") {
				this.deepFreeze(value);
			}
		}

		return Object.freeze(obj) as DeepReadonly<T>;
	}
}
