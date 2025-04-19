import type { BinaryNode } from "@wha.ts/binary/src/types";
import type { KeyPair } from "@wha.ts/utils/src/types";

export interface ScenarioStep {
	/** Node the mock expects the client to send. `null` to skip expectation. */
	expect?: Partial<BinaryNode> | null;
	/** Function to validate the received node more deeply. Return true if valid. */
	validate?: (received: BinaryNode) => boolean;
	/** Node(s) the mock should send back in response. */
	send?: BinaryNode | BinaryNode[] | null;
	/** Action to perform (e.g., 'close', 'wait') */
	action?: "close" | "wait" | { type: "wait"; duration: number };
	/** Description for debugging */
	description?: string;
}

export type TestScenario = ScenarioStep[];

export interface MockWebSocketData {
	state:
		| "connecting"
		| "handshaking"
		| "handshake_complete"
		| "authenticated"
		| "error";
	sessionId: string;
	currentScenario: TestScenario;
	scenarioStepIndex: number;
	frameBuffer: Uint8Array;
	waHeaderProcessed: boolean;
	noiseState?: MockNoiseState; // Keep this defined
}

export interface MockNoiseState {
	handshakeHash: Uint8Array;
	salt: Uint8Array;
	cipherKeyEncrypt: Uint8Array;
	cipherKeyDecrypt: Uint8Array;
	encryptNonce: bigint;
	decryptNonce: bigint;
	responderStaticPair?: KeyPair;
	responderEphemeralPair?: KeyPair;
	initiatorStaticPublicKey?: Uint8Array;
}

export interface MockServerConfig {
	port?: number;
	host?: string;
	logger?: Pick<Console, "log" | "warn" | "error" | "info" | "debug">;
	scenarioProvider: (sessionId: string) => TestScenario;
}
