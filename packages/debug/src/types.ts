// TypeScript interfaces for debug events, states, and commands.

export interface NetworkEvent {
	timestamp: number;
	direction: "send" | "receive";
	layer: "websocket_raw" | "frame_raw" | "noise_payload" | "xmpp_node";
	data: Uint8Array | string | object;
	length?: number;
	metadata?: Record<string, any>;
	error?: string;
}

export interface ClientEventRecord {
	timestamp: number;
	eventName: string;
	payload: any;
	sourceComponent: string;
}

export interface ErrorRecord {
	timestamp: number;
	source: string;
	message: string;
	stack?: string;
	context?: any;
}

export interface ComponentStateSnapshot {
	timestamp: number;
	componentId: string;
	state: any;
}
