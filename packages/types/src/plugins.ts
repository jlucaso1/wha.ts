import type { BinaryNode } from "@wha.ts/binary";
import type { AuthenticationCreds } from "./index";

// Deep readonly utility type
export type DeepReadonly<T> = {
	readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

// Logger interface - reusing from existing structure
export interface ILogger {
	trace(...args: any[]): void;
	debug(...args: any[]): void;
	info(...args: any[]): void;
	warn(...args: any[]): void;
	error(...args: any[]): void;
}

// Client event map - we'll import this from core when needed
export interface ClientEventMap {
	"connection.update": any;
	"creds.update": any;
	"message.received": any;
	"message.decryption_error": any;
	"node.received": any;
	"node.sent": any;
}

// API STYLE: The IPlugin interface is declarative. It clearly states its identity and the API it exposes.
export interface IPlugin<T extends Record<string, any> = Record<string, any>> {
	name: string;
	version: string;
	// The API object that will be merged with the client instance.
	// The generic `T` allows plugin authors to get type support for their own API.
	api?: T;
	// The entry point for the plugin, where it receives the sandboxed API handle.
	install(api: PluginAPI): void;
}

// The secure toolkit passed to every plugin.
// API STYLE: This interface is carefully curated to expose only what is necessary and safe.
export interface PluginAPI {
	// 1. Data Access (Read-Only)
	// API STYLE: All data access must be read-only to prevent plugins from directly mutating the core state.
	getAuthState(): DeepReadonly<AuthenticationCreds>;

	// 2. Core Actions (Write/Perform)
	// API STYLE: Actions are namespaced under `actions` to make their purpose clear.
	// These are stable, high-level functions.
	readonly actions: {
		sendTextMessage(
			jid: string,
			text: string,
		): Promise<{ messageId: string; ack?: BinaryNode; error?: string }>;
		sendPresenceUpdate(
			type: "available" | "unavailable" | "composing" | "paused",
			toJid?: string,
		): Promise<void>;
		// Future stable actions will be added here.
	};

	// 3. Event Bus (Listen)
	// Provides access to the client's event stream.
	on<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void;

	// 4. Lifecycle Hooks (Tap-in)
	// Allows plugins to tap into specific points in the client's lifecycle.
	readonly hooks: {
		readonly onPreDecrypt: {
			// Registers a callback to be fired right before a message is decrypted.
			tap: (callback: (node: BinaryNode) => void) => void;
		};
		// More hooks (e.g., onConnect, onPreSend) can be added here in the future.
	};

	// 5. Utilities
	readonly logger: ILogger;
}

// --- Type-level utilities for the factory function ---

// Merges an array of plugins into a single API object type.
export type MergePlugins<T extends readonly IPlugin[]> = UnionToIntersection<
	NonNullable<T[number]["api"]>
>;

// Utility to convert a union of types (A | B) into an intersection (A & B).
// This is essential for merging the different plugin APIs.
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
	k: infer I,
) => void
	? I
	: never;
