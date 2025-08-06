import type { BinaryNode } from "@wha.ts/binary";
import type {
	AuthenticationCreds,
	ClientEventMap,
	DeepReadonly,
	IPlugin,
	PluginAPI,
} from "@wha.ts/types";
import type { ILogger } from "../transport/types";

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
	public getExposedApis(): Record<string, unknown> {
		const aggregatedAPI: Record<string, unknown> = {};

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

	private createSandboxedAPI(): PluginAPI {
		return {
			getAuthState: (): DeepReadonly<AuthenticationCreds> => {
				return this.deepFreeze(this.client.auth.creds);
			},

			actions: {
				sendTextMessage: (jid: string, text: string) =>
					this.client.sendTextMessage(jid, text),
				sendPresenceUpdate: (
					type: "available" | "unavailable" | "composing" | "paused",
					toJid?: string,
				) => this.client.sendPresenceUpdate(type, toJid),
			},

			on: <K extends keyof ClientEventMap>(
				event: K,
				listener: (data: ClientEventMap[K]) => void,
			) => {
				this.client.addListener(event, listener);
			},

			hooks: {
				onPreDecrypt: {
					tap: (callback: (node: BinaryNode) => void) => {
						this.preDecryptCallbacks.push(callback);
					},
				},
			},

			logger: this.client.logger,
		};
	}

	private deepFreeze<T>(obj: T): DeepReadonly<T> {
		const propNames = Object.getOwnPropertyNames(obj);

		for (const name of propNames) {
			const value = (obj as Record<string, unknown>)[name];
			if (value && typeof value === "object") {
				this.deepFreeze(value);
			}
		}

		return Object.freeze(obj) as DeepReadonly<T>;
	}
}
