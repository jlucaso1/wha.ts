import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import { S_WHATSAPP_NET } from "@wha.ts/binary/src/jid-utils";
import { type WhaTSClient, createWAClient } from "@wha.ts/core/src/client";
import { GenericAuthState } from "@wha.ts/core/src/state/providers/generic-auth-state";
import {
	type MockWhatsAppServer,
	type TestScenario,
	createMockServer,
} from "@wha.ts/whatsapp-mock-server/src";

// --- Mock Server Setup ---
let mockServer: MockWhatsAppServer;
const mockServerPort = 3001; // Use a different port

// Define Scenarios
const pairingScenario: TestScenario = [
	// Handshake happens implicitly via noise-simulator
	// 1. Server sends pair-device IQ
	{
		description: "Server sends pair-device IQ",
		expect: null, // Server initiates this
		send: {
			// This is the server's first application-level message
			tag: "iq",
			attrs: { type: "set", id: "pair-iq-1", from: S_WHATSAPP_NET },
			content: [
				{
					tag: "pair-device",
					attrs: {},
					content: [
						{ tag: "ref", attrs: {}, content: Buffer.from("mock_ref_1") },
					],
				}, // Use Buffer for content
			],
		},
	},
	// 2. Client should send ACK for pair-device
	{
		description: "Client sends pair-device ACK",
		expect: {
			tag: "iq",
			attrs: { type: "result", to: S_WHATSAPP_NET, id: "pair-iq-1" },
		},
		send: null, // Server waits for next step
	},
	// 3. Server sends pair-success IQ (simplified content)
	{
		description: "Server sends pair-success IQ",
		expect: null, // Server initiates this after ACK (or based on test timing)
		send: {
			tag: "iq",
			attrs: { type: "result", id: "pair-success-iq-1", from: S_WHATSAPP_NET }, // Client needs to send pair-device-sign IQ first usually, simplifying here
			content: [
				{
					tag: "pair-success", // Simplified: Missing device-identity, platform etc.
					attrs: { jid: "1234567890@s.whatsapp.net" }, // The JID client should adopt
				},
			],
		},
	},
	// 4. Client MAY send ACK for pair-success (often client just closes connection on new login)
	// Let's assume client closes or sends presence, we'll end scenario here
];

const loginScenario: TestScenario = [
	// Handshake happens implicitly via noise-simulator
	// 1. Client sends login node (<iq type="set" id="login-1" ..><ping/></iq> or similar auth node)
	//    Actual login payload is encrypted in ClientFinish, server sends <success> after handshake.
	//    So the mock doesn't really 'expect' a specific node *before* sending success.
	// {
	//    description: "Client sends initial presence/IQ after handshake",
	//    expect: { tag: 'presence', attrs: { name: 'some_name' } }, // Or whatever client sends first
	//    send: null
	// },
	// 2. Server sends login success
	{
		description: "Server sends login success",
		expect: null, // Server sends this after successful handshake/auth
		send: {
			tag: "success",
			attrs: {
				status: "200",
				props: "0",
				profile_pic_thumb: "",
				location: "use_lid",
				// ... other attributes from a real session
				jid: "9876543210@s.whatsapp.net", // The JID the client should use
			},
		},
		// After sending success, the state becomes authenticated
		// action: () => ws.data.state = 'authenticated' // (Can't do this easily here)
	},
	// 3. Client might send presence or other IQs
	{
		description: "Client sends initial presence after login",
		expect: { tag: "presence", attrs: { type: "available" } },
		send: null,
	},
	// ... more steps like receiving a ping, sending a pong etc.
];

describe("Client with Mocked Server", async () => {
	const authState = await GenericAuthState.init();
	let client: WhaTSClient;
	// --- Test Suite ---
	beforeAll(async () => {
		// Start a new mock server for each test
		mockServer = createMockServer({
			port: mockServerPort,
			logger: console, // Use Bun's test logger or console
			scenarioProvider: (sessionId: string) => {
				console.log(`[Test Setup] Providing scenario for session ${sessionId}`);
				// Choose scenario based on test case (e.g., using a global variable set by test)
				// For now, let's default to pairing
				return loginScenario; // CHANGE THIS TO pairingScenario FOR PAIRING TEST
			},
		});
		await mockServer.start();

		client = createWAClient({
			auth: authState,
			logger: console,
			wsOptions: {
				url: new URL(`ws://localhost:${mockServerPort}/ws`),
			},
		});
	});

	afterAll(() => {
		mockServer?.stop();
		client.ws?.close();
	});

	test("Client should connect and simulate successful login", async () => {
		// IMPORTANT: Use the *registered* JID expected from the loginScenario
		authState.creds.me = { id: "9876543210@s.whatsapp.net" };
		authState.creds.registered = true; // Mark as registered for login flow

		let connectionOpened = false;
		let receivedSuccess = false;

		const openPromise = new Promise<void>((resolve) => {
			client.addListener("connection.update", (update) => {
				console.log("[Client Update]", update);
				if (update.connection === "open") {
					connectionOpened = true;
					// Check if the success node was processed and JID updated
					expect(client.auth.creds.me?.id).toBe("9876543210@s.whatsapp.net");
					receivedSuccess = true; // Or check based on server log/state if needed
					resolve();
				}
				if (update.connection === "close" && update.error) {
					console.error("Client connection closed with error:", update.error);
				}
			});
		});

		await client.connect(); // Start connection attempt

		// Wait for the connection to open (or timeout)
		await openPromise;

		expect(connectionOpened).toBe(true);
		expect(receivedSuccess).toBe(true); // Ensure the success node logic ran

		// Add further assertions: e.g., try sending a message which should hit the mock
		// await client.sendTextMessage('...');
	}); // Increase timeout if needed

	// Add another test for the pairing flow
	// test('Client should handle QR code pairing flow', async () => { ... });
});
