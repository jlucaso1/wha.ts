// TypeScript interfaces for debug events, states, and commands.

import type { BinaryNode } from "@wha.ts/binary";

interface BaseNetworkEvent {
	timestamp: number;
	direction: "send" | "receive";
	length?: number;
	metadata?: Record<string, unknown>;
	error?: string;
}

export type NetworkEvent =
	| (BaseNetworkEvent & {
			layer: "websocket_raw" | "frame_raw" | "noise_payload";
			data: Uint8Array;
	  })
	| (BaseNetworkEvent & {
			layer: "xmpp_node";
			data: BinaryNode;
	  });

export interface ClientEventRecord {
	timestamp: number;
	eventName: string;
	payload: unknown;
	sourceComponent: string;
}

export interface ErrorRecord {
	timestamp: number;
	source: string;
	message: string;
	stack?: string;
	context?: unknown;
}

export interface ComponentStateSnapshot {
	timestamp: number;
	componentId: string;
	state: unknown;
}
