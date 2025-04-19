import { decodeBinaryNode } from "@wha.ts/binary/src/decode";
import type { BinaryNode } from "@wha.ts/binary/src/types";
import { NOISE_WA_HEADER } from "@wha.ts/core/src/defaults";
import {
	bytesToHex,
	concatBytes,
	equalBytes,
} from "@wha.ts/utils/src/bytes-utils";
import type { Server, ServerWebSocket } from "bun";
import { addLengthPrefix, frameBinaryNode, parseFrames } from "./frame-handler";
import { handleNoiseHandshakeMessage } from "./noise-simulator";
import type {
	MockServerConfig,
	MockWebSocketData,
	ScenarioStep,
	TestScenario,
} from "./types";

export class MockWhatsAppServer {
	private server: Server | null = null;
	private config: Required<MockServerConfig>;
	private activeSockets = new Map<string, ServerWebSocket<MockWebSocketData>>();

	constructor(config: MockServerConfig) {
		this.config = {
			port: config.port ?? 3000,
			host: config.host ?? "localhost",
			logger: config.logger ?? console,
			scenarioProvider: config.scenarioProvider,
		};
	}

	start(): Promise<Server> {
		return new Promise((resolve, reject) => {
			try {
				this.server = Bun.serve<MockWebSocketData, undefined>({
					port: this.config.port,
					hostname: this.config.host,
					fetch: this.handleFetch,
					websocket: {
						open: this.handleWebSocketOpen,
						message: this.handleWebSocketMessage,
						close: this.handleWebSocketClose,
						drain: this.handleWebSocketDrain,
						// idleTimeout: 120, // Default or configure via config
						// maxPayloadLength: 16 * 1024 * 1024, // Default or configure
					},
					error: (error) => {
						this.config.logger.error("Server error:", error);
						reject(error); // Reject promise on server startup error
						return new Response("Server error", { status: 500 });
					},
				});
				this.config.logger.info(
					`Mock WhatsApp Server listening on ws://${this.server.hostname}:${this.server.port}`,
				);
				resolve(this.server);
			} catch (error) {
				this.config.logger.error("Failed to start mock server:", error);
				reject(error);
			}
		});
	}

	stop() {
		this.config.logger.info("Stopping mock WhatsApp server...");
		for (const [sessionId, ws] of this.activeSockets.entries()) {
			this.config.logger.info(
				`[${sessionId}] Closing WebSocket connection during server shutdown.`,
			);
			ws.close(1001, "Server shutting down");
		}
		this.activeSockets.clear();
		const stopped = this.server?.stop(true); // true for graceful shutdown
		this.server = null;
		if (stopped) {
			this.config.logger.info("Mock server stopped.");
		} else {
			this.config.logger.warn("Mock server might not have stopped cleanly.");
		}
	}

	// --- Request Handler ---
	private handleFetch = (
		req: Request,
		server: Server,
	): Response | undefined => {
		const url = new URL(req.url);
		// Basic routing for WebSocket upgrade
		if (url.pathname === "/ws" || url.pathname === "/ws/chat") {
			const sessionId = crypto.randomUUID();
			const scenario = this.config.scenarioProvider(sessionId);
			if (!scenario || scenario.length === 0) {
				this.config.logger.error(
					`No scenario provided for new session ${sessionId}`,
				);
				return new Response("Scenario configuration error", { status: 500 });
			}

			const upgraded = server.upgrade<MockWebSocketData>(req, {
				data: {
					state: "connecting",
					sessionId: sessionId,
					currentScenario: scenario,
					scenarioStepIndex: 0,
					frameBuffer: new Uint8Array(),
					waHeaderProcessed: false,
				},
			});

			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			// Return undefined explicitly signifies the upgrade is happening
			return undefined;
		}

		return new Response("Not Found", { status: 404 });
	};

	// --- WebSocket Handlers ---
	private handleWebSocketOpen = (ws: ServerWebSocket<MockWebSocketData>) => {
		ws.data.state = "handshaking";
		this.activeSockets.set(ws.data.sessionId, ws);
		this.config.logger.info(
			`[${ws.data.sessionId}] WebSocket connection opened. State: ${ws.data.state}`,
		);
		// Do not send any initial message; wait for client to send first
	};

	private handleWebSocketMessage = (
		ws: ServerWebSocket<MockWebSocketData>,
		message: Uint8Array | string,
	) => {
		if (typeof message === "string") {
			this.config.logger.warn(
				// Use configured logger
				`[${ws.data.sessionId}] Received string message: ${message}`,
			);
			return;
		}
		const sessionId = ws.data.sessionId;
		this.config.logger.debug(
			// Use configured logger
			`[${sessionId}] Received message (type: ${typeof message}, length: ${
				message.byteLength ?? "N/A"
			})`,
		);
		ws.data.frameBuffer = concatBytes(ws.data.frameBuffer, message);
		this.config.logger.debug(
			`[${sessionId}] Frame buffer length after append: ${ws.data.frameBuffer.length}`,
		);

		if (
			!ws.data.waHeaderProcessed &&
			ws.data.state === "handshaking" &&
			ws.data.frameBuffer.length >= NOISE_WA_HEADER.length
		) {
			this.config.logger.debug(`[${sessionId}] Checking for WA header...`);
			if (
				equalBytes(
					ws.data.frameBuffer.subarray(0, NOISE_WA_HEADER.length),
					NOISE_WA_HEADER,
				)
			) {
				this.config.logger.info(
					`[${sessionId}] Found and removing WA header from buffer.`,
				);
				ws.data.frameBuffer = ws.data.frameBuffer.subarray(
					NOISE_WA_HEADER.length,
				);
				ws.data.waHeaderProcessed = true;
				this.config.logger.debug(
					`[${sessionId}] Frame buffer length after header removal: ${ws.data.frameBuffer.length}`,
				);
			} else {
				// This shouldn't happen for the *first* message in handshake state, but log defensively
				this.config.logger.warn(
					`[${sessionId}] Expected WA header in handshake state but not found. Buffer starts with: ${bytesToHex(
						ws.data.frameBuffer.slice(0, 4),
					)}`,
				);
				// We might want to close the connection here if the protocol is strictly expected
				// ws.close(1002, "Expected WA header missing");
				// return;
			}
		}

		// Make sure the logger inside parseFrames can work, maybe pass it?
		// For now, relying on the global console logger added in frame-handler.ts
		ws.data.frameBuffer = parseFrames(ws.data.frameBuffer, (frameData) => {
			// Callback provided to parseFrames
			this.config.logger.debug(
				// Use configured logger
				`[${sessionId}] Processing complete frame (length: ${frameData.length}) via callback`,
			);
			this.handleCompleteFrame(ws, frameData); // Call the actual handler
		});
	};

	private handleCompleteFrame = (
		ws: ServerWebSocket<MockWebSocketData>,
		frameData: Uint8Array,
	) => {
		this.config.logger.debug(
			`[handleCompleteFrame] Entered. Frame data length: ${frameData.length}. State: ${ws.data.state}`,
		);
		const { state, sessionId } = ws.data;

		if (state === "handshaking") {
			this.config.logger.debug(
				"[handleCompleteFrame] State is handshaking, calling handleNoiseHandshakeMessage...",
			);
			// The Noise simulator expects the HandshakeMessage payload
			// handleInitialClientMessage might be too simple if client sends prologue + hello separately
			// For wha.ts, the first message is Prologue+FramedClientHello, second is FramedClientFinish
			if (!handleNoiseHandshakeMessage(ws, frameData)) {
				// Assuming frameData IS the HandshakeMessage payload
				this.config.logger.error(`[${sessionId}] Noise handshake failed.`);
				// handleNoiseHandshakeMessage should close the socket on error
			} else {
				this.config.logger.debug(
					"[handleCompleteFrame] handleNoiseHandshakeMessage returned true.",
				);
				// If handshake became complete, process next scenario step
				if (ws.data.state === "handshake_complete") {
					this.config.logger.debug(
						"[handleCompleteFrame] Handshake complete, processing next scenario step.",
					);
					this.processNextScenarioStep(ws);
				} else {
					this.config.logger.debug(
						"[handleCompleteFrame] Handshake still in progress after processing message.",
					);
				}
			}
		} else if (state === "authenticated") {
			try {
				const receivedNode = decodeBinaryNode(frameData); // Assumes frameData is DECOMPRESSED node bytes
				this.config.logger.info(
					`[${sessionId}] Received Node:`,
					receivedNode.tag,
					receivedNode.attrs,
				);
				this.processScenarioStepWithNode(ws, receivedNode);
			} catch (error) {
				this.config.logger.error(
					`[${sessionId}] Error decoding binary node:`,
					error,
				);
				ws.close(1008, "Failed to decode node");
			}
		} else if (state === "handshake_complete") {
			// This state might be transient, waiting for the scenario to send <success>
			// Or the client might send the next node immediately
			try {
				const receivedNode = decodeBinaryNode(frameData);
				this.config.logger.info(
					`[${sessionId}] Received Node (post-handshake):`,
					receivedNode.tag,
					receivedNode.attrs,
				);
				// Technically should be authenticated now
				ws.data.state = "authenticated";
				this.config.logger.debug(
					"[handleCompleteFrame] Transitioned state to authenticated.",
				);
				this.processScenarioStepWithNode(ws, receivedNode);
			} catch (error) {
				this.config.logger.error(
					`[${sessionId}] Error decoding binary node (post-handshake):`,
					error,
				);
				ws.close(1008, "Failed to decode node");
			}
		} else {
			this.config.logger.warn(
				`[${sessionId}] Received message in unexpected state: ${state}`,
			);
			// Optional: close connection or just ignore
		}
	};

	private processScenarioStepWithNode = (
		ws: ServerWebSocket<MockWebSocketData>,
		receivedNode: BinaryNode,
	) => {
		const stepIndex = ws.data.scenarioStepIndex;
		const scenario = ws.data.currentScenario;

		if (stepIndex >= scenario.length) {
			this.config.logger.warn(
				`[${ws.data.sessionId}] Received node after scenario ended:`,
				receivedNode.tag,
			);
			// Decide what to do: ignore, error, close?
			// ws.close(1002, "Unexpected message after scenario end");
			return;
		}

		const currentStep = scenario[stepIndex];
		this.config.logger.debug(
			`[${ws.data.sessionId}] Executing scenario step ${stepIndex}: ${
				currentStep?.description ?? "No description"
			}`,
		);

		// 1. Check Expectation
		let expectationMet = true;
		if (currentStep?.expect) {
			expectationMet = this.compareNodes(currentStep.expect, receivedNode);
			if (expectationMet && currentStep.validate) {
				expectationMet = currentStep.validate(receivedNode);
			}
		} else if (currentStep?.validate) {
			// Only validation function provided
			expectationMet = currentStep.validate(receivedNode);
		}
		// If currentStep.expect is null/undefined, we didn't expect the client to send anything here.
		// If it *did* send something, it might be an error unless the *next* step expects it.
		// For simplicity now: if expect is not set, we don't fail if we receive something,
		// but we only proceed if the received node matches the *next* step's expectation.
		// A cleaner way might be explicit "receive" steps.

		if (!expectationMet && currentStep?.expect !== null) {
			this.config.logger.error(
				`[${ws.data.sessionId}] Expectation failed at step ${stepIndex}`,
			);
			this.config.logger.error("  Expected:", currentStep?.expect);
			this.config.logger.error("  Received:", {
				tag: receivedNode.tag,
				attrs: receivedNode.attrs,
			}); // Avoid logging full content potentially
			ws.close(1002, `Expectation failed at step ${stepIndex}`);
			return;
		}

		// 2. Perform Action / Send Response (if expectation met or not required)
		ws.data.scenarioStepIndex++; // Advance step index *before* sending response
		this.processNextScenarioStep(ws); // This will handle sending/actions for the *new* current step
	};

	// Processes the *current* step index, handling actions and sending
	private processNextScenarioStep = (
		ws: ServerWebSocket<MockWebSocketData>,
	) => {
		const stepIndex = ws.data.scenarioStepIndex;
		const scenario = ws.data.currentScenario;
		const sessionId = ws.data.sessionId;

		if (stepIndex >= scenario.length) {
			this.config.logger.info(`[${sessionId}] Scenario completed.`);
			// Optionally close the connection after a delay? Or leave open?
			return;
		}

		const currentStep = scenario[stepIndex];
		this.config.logger.debug(
			`[${sessionId}] Processing action/send for step ${stepIndex}: ${
				currentStep?.description ?? "No description"
			}`,
		);

		// Handle actions first
		if (currentStep?.action) {
			if (currentStep.action === "close") {
				this.config.logger.info(
					`[${sessionId}] Scenario action: Closing connection.`,
				);
				ws.close(1000, "Scenario action: close");
				return; // Stop processing scenario
			}
			if (currentStep.action === "wait" || currentStep.action.type === "wait") {
				const duration =
					typeof currentStep.action === "object"
						? currentStep.action.duration
						: 100; // Default wait time
				this.config.logger.info(
					`[${sessionId}] Scenario action: Waiting for ${duration}ms.`,
				);
				setTimeout(() => {
					// After waiting, check if we should send something defined in the *same* step
					this.sendFromStep(ws, currentStep);
					// We don't automatically advance the step here after wait,
					// the wait might be *before* expecting client input for this step.
					// Or the wait is just a pause before the server sends something.
					// Let's assume wait is just a pause before sending.
				}, duration);
				return; // Don't process send immediately
			}
		}

		// Handle sending
		this.sendFromStep(ws, currentStep);

		// If the current step ONLY sends/acts and expects nothing, advance again
		// Caution: This could lead to infinite loops if not designed carefully
		// Example: Server sends presence, then immediately sends another presence without client input expected
		// A safer design might require explicit 'wait_for_client' markers or rely on timeouts.
		// For now, we only advance based on receiving a message matching 'expect'.
		// If a step only sends, we wait for the client to send something matching the *next* step's 'expect'.
	};

	private sendFromStep = (
		ws: ServerWebSocket<MockWebSocketData>,
		step: ScenarioStep | undefined,
	) => {
		if (!step?.send) return;
		const sessionId = ws.data.sessionId;

		const nodesToSend = Array.isArray(step.send) ? step.send : [step.send];

		// biome-ignore lint/complexity/noForEach: <explanation>
		nodesToSend.forEach((node) => {
			if (node) {
				try {
					this.config.logger.info(
						`[${sessionId}] Sending Node:`,
						node.tag,
						node.attrs,
					);
					const frame = frameBinaryNode(node);
					const sent = ws.sendBinary(frame); // Use sendBinary for raw bytes
					if (sent <= 0) {
						this.config.logger.warn(
							`[${sessionId}] Failed to send node (backpressure or closed):`,
							node.tag,
						);
						// Optionally close on failure?
					}
				} catch (error) {
					this.config.logger.error(
						`[${sessionId}] Error encoding/framing node for sending:`,
						error,
					);
					ws.close(1011, "Internal server error during send");
				}
			}
		});
	};

	private handleWebSocketClose = (
		ws: ServerWebSocket<MockWebSocketData>,
		code: number,
		reason: string,
	) => {
		this.activeSockets.delete(ws.data.sessionId);
		this.config.logger.info(
			`[${
				ws.data.sessionId
			}] WebSocket connection closed. Code: ${code}, Reason: ${reason || "N/A"}`,
		);
		// Clean up associated resources if any
	};

	private handleWebSocketDrain = (ws: ServerWebSocket<MockWebSocketData>) => {
		this.config.logger.debug(
			`[${ws.data.sessionId}] WebSocket drained (backpressure released).`,
		);
		// Can be used to resume sending if paused due to backpressure
	};

	// Simple node comparison (customize as needed)
	private compareNodes(
		expected: Partial<BinaryNode>,
		actual: BinaryNode,
	): boolean {
		if (expected.tag && expected.tag !== actual.tag) return false;
		if (expected.attrs) {
			for (const key in expected.attrs) {
				if (expected.attrs[key] !== actual.attrs[key]) return false;
			}
		}
		// Add content comparison if needed (beware of Uint8Array comparison)
		if (expected.content !== undefined) {
			if (
				typeof expected.content === "string" &&
				typeof actual.content === "string"
			) {
				if (expected.content !== actual.content) return false;
			} else if (
				expected.content instanceof Uint8Array &&
				actual.content instanceof Uint8Array
			) {
				// Use a proper byte comparison function
				if (!equalBytes(expected.content, actual.content)) return false;
			} else if (
				Array.isArray(expected.content) &&
				Array.isArray(actual.content)
			) {
				// Basic length check, could do deep comparison
				if (expected.content.length !== actual.content.length) return false;
				// TODO: Implement deep array comparison if necessary
			} else {
				// Type mismatch or unhandled comparison
				return false;
			}
		}
		return true;
	}
}

// Factory function
export function createMockServer(config: MockServerConfig): MockWhatsAppServer {
	return new MockWhatsAppServer(config);
}
