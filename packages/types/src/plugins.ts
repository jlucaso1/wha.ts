import type { BinaryNode } from "@wha.ts/binary";
import type { AuthenticationCreds } from "./index";
import type { ILogger } from "./transport";

export type DeepReadonly<T> = {
	readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/**
 * This interface is intended to be extended via declaration merging.
 * Higher-level packages like @wha.ts/core will populate it with concrete event types.
 */

// biome-ignore lint/suspicious/noEmptyInterface: This interface is intentionally left empty
export interface ClientEventMap {}

export interface IPlugin<T extends object = object> {
	name: string;
	version: string;
	api?: T;
	install(api: PluginAPI): void;
}

export interface PluginAPI {
	getAuthState(): DeepReadonly<AuthenticationCreds>;

	readonly actions: {
		sendTextMessage(
			jid: string,
			text: string,
		): Promise<{ messageId: string; ack?: BinaryNode; error?: string }>;
		sendPresenceUpdate(
			type: "available" | "unavailable" | "composing" | "paused",
			toJid?: string,
		): Promise<void>;
	};

	on<K extends keyof ClientEventMap>(
		event: K,
		listener: (data: ClientEventMap[K]) => void,
	): void;

	readonly hooks: {
		readonly onPreDecrypt: {
			tap: (callback: (node: BinaryNode) => void) => void;
		};
	};

	readonly logger: ILogger;
}

export type MergePlugins<T extends readonly IPlugin[]> = UnionToIntersection<
	NonNullable<T[number]["api"]>
>;

type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never;
