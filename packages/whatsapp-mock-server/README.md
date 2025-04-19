# packages/whatsapp-mock-server

**Purpose:** Provides a mock WhatsApp WebSocket server designed for reliable end-to-end (E2E) testing of WhatsApp client libraries (like `@wha.ts/core`, Baileys, etc.).

## The Problem with Raw Traffic Replay

Attempting to test clients by capturing and replaying raw encrypted WebSocket traffic from a real session is **fundamentally flawed**. WhatsApp communication relies heavily on cryptographic protocols:

1.  **Noise Protocol Framework (XX Pattern):** Used for the initial handshake. It establishes shared secrets and derives session keys based on ephemeral and static key pairs exchanged during the handshake. These keys are unique to each session.
2.  **Signal Protocol:** Used for encrypting the content of messages *after* the handshake.

Replaying captured encrypted bytes fails because the client under test will generate different ephemeral keys for the handshake and cannot decrypt the replayed server messages. Its own encrypted messages also won't match the captured ones.

## Solution: High-Level Mock Server Simulation

This package provides a mock server that simulates WhatsApp's behavior at relevant protocol levels, enabling robust testing without relying on fragile byte replay.

**Core Idea:**

The mock server simulates:

1.  **WebSocket Connection:** Handling connections, messages, and lifecycle events.
2.  **Noise Protocol Handshake (XX Pattern):** Crucially, it simulates the *cryptographic state transitions* of the handshake. It performs its *own* Diffie-Hellman exchanges, HKDF key derivations, hash mixing, and AES-GCM encryption/decryption *internally* to generate cryptographically plausible responses (like `ServerHello`) based on the client's messages (`ClientHello`, `ClientFinish`). This allows the *client under test* to successfully validate the handshake sequence and derive the correct transport keys, even though the mock doesn't possess the client's actual long-term identity keys.
3.  **WebSocket Framing:** Handles WhatsApp's specific framing:
    *   The initial `WA` + version header sent by the client.
    *   The 3-byte big-endian length prefix for subsequent logical frames (containing Noise messages or XMPP nodes).
4.  **XMPP Stanza (`BinaryNode`) Exchange:** After the handshake, it decodes incoming client nodes and sends back responses according to predefined test scenarios.

## Key Components

1.  **Bun WebSocket Server:**
    *   Leverages `Bun.serve()` with its `websocket` handler for the underlying transport layer, managing connections and events (`open`, `message`, `close`, `drain`).

2.  **Noise Handshake Simulator (`noise-simulator.ts`):**
    *   **Purpose:** Guides the client through the Noise XX handshake by simulating the server's cryptographic operations.
    *   **Functionality:**
        *   Receives and decodes the client's `ClientHello`.
        *   Performs internal state updates (hash mixing, key derivation via HKDF based on DH results using its *own* static/ephemeral keys).
        *   Generates a `ServerHello` message, **encrypting** the `static` public key and `payload` fields using the derived session keys and correct nonces, simulating the real server's behavior.
        *   Receives and decodes the client's `ClientFinish`.
        *   Performs internal state updates, **decrypting** the `static` key and `payload` using the derived session keys and correct nonces.
        *   Derives the final transport encryption/decryption keys (though these aren't strictly needed by the mock itself post-handshake, the process ensures the handshake hash state was correct).
        *   Transitions the connection state to `handshake_complete`.

3.  **WebSocket Frame Handler (`frame-handler.ts`):**
    *   **Purpose:** Manages WhatsApp's custom WebSocket framing.
    *   **Functionality:**
        *   **Receiving:** On the *first* message from the client in the `handshaking` state, it identifies and strips the `WA` header (`[87, 65, ...]`). It then buffers incoming data and extracts complete logical frames based on the 3-byte big-endian length prefix present on *all* subsequent logical frames (including the rest of the handshake and XMPP nodes).
        *   **Sending:** Prepends the correct 3-byte length prefix to outgoing logical frames (Noise messages or encoded `BinaryNode`s) before sending them over the WebSocket.

4.  **XMPP (`BinaryNode`) Processor (`server.ts`):**
    *   **Purpose:** Simulates application-level communication *after* the handshake.
    *   **Functionality:**
        *   Receives framed data (already decrypted by the client library if it was a transport message) via the Frame Handler.
        *   Uses the client library's `decodeBinaryNode` (e.g., from `@wha.ts/binary`) to parse the frame data into a structured `BinaryNode` object.
        *   Compares the received `BinaryNode` against the `expect` criteria defined in the current test scenario step.
        *   Executes optional `validate` functions from the scenario step.
        *   Retrieves the corresponding response `BinaryNode`(s) from the `send` property of the scenario step.
        *   Uses `encodeBinaryNode` to serialize the response node(s).
        *   Passes the encoded bytes to the Frame Handler for prefixing and sending.

5.  **Scenario Engine & State Management (`server.ts`, `types.ts`):**
    *   **Purpose:** To define and execute specific test flows.
    *   **Functionality:**
        *   Tests are defined as `TestScenario` (arrays of `ScenarioStep`).
        *   Each `ScenarioStep` defines:
            *   `expect`: (Optional) A `Partial<BinaryNode>` the mock expects the client to send.
            *   `validate`: (Optional) A function for complex validation `(received: BinaryNode) => boolean`.
            *   `send`: (Optional) A `BinaryNode` or `BinaryNode[]` the mock should send.
            *   `action`: (Optional) Actions like `'close'` or `'wait'`.
            *   `description`: (Optional) String for logging.
        *   Attaches `MockWebSocketData` state to each socket, tracking `state`, `currentScenario`, `scenarioStepIndex`, `frameBuffer`, `waHeaderProcessed`, and the crucial `noiseState` during the handshake simulation.
        *   Processes steps sequentially based on received messages and scenario definitions.

## Handling Signal Protocol (Message Content Encryption)

*   The mock server **does NOT handle Signal Protocol** encryption/decryption for message *content* (`<message><enc type="pkmsg/msg">...</enc></message>`).
*   Testing message encryption/decryption should be done within the E2E test setup itself:
    1.  **Setup:** Initialize the client's `SignalProtocolStore` with known, deterministic keys for the test client and a simulated "contact".
    2.  **Encrypt (in Test):** Use the client library's `SessionCipher` (or equivalent) *in the test code* to encrypt a known plaintext message using the test keys. This produces the ciphertext bytes.
    3.  **Scenario:** Define a `ScenarioStep` where the mock server `send`s a `<message>` `BinaryNode` containing the pre-encrypted ciphertext (from step 2) inside the `<enc>` tag.
    4.  **Assert (in Test):** The E2E test asserts that the *client under test* correctly receives the node from the mock, uses its Signal store to decrypt it, and emits an event (e.g., `message.received`) containing the original *plaintext*.
    5.  **Sending Test:** Assert the client sends a correctly structured `<message><enc>...</enc></message>` node; the mock's `expect` step verifies this structure without needing to decrypt the content.

## Usage Example (in an E2E Test File)

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type WhaTSClient, createWAClient } from "@wha.ts/core"; // Your client library
import { GenericAuthState } from "@wha.ts/core/src/state/providers/generic-auth-state"; // Your auth state
import {
    type MockWhatsAppServer,
    type TestScenario,
    createMockServer,
} from "@wha.ts/whatsapp-mock-server"; // Import the mock server
import { S_WHATSAPP_NET } from "@wha.ts/binary"; // JID constants if needed

let mockServer: MockWhatsAppServer;
const mockServerPort = 3001; // Or any available port

// Define a test scenario (e.g., successful login)
const loginScenario: TestScenario = [
    // Note: Handshake (ClientHello/ServerHello/ClientFinish) is handled implicitly
    // by the mock server before the scenario starts.
    {
        description: "Server sends login success node",
        expect: null, // Server sends this proactively after handshake complete
        send: {
            tag: "success",
            attrs: { // Realistic attributes
                status: "200",
                props: "0",
                profile_pic_thumb: "",
                location: "use_lid",
                jid: "9876543210@s.whatsapp.net", // Client should adopt this
            },
        },
    },
    {
        description: "Client sends initial presence after login",
        expect: { // Expect the client to send this
            tag: "presence",
            attrs: { type: "available" },
        },
        send: null, // Mock just waits for next client action or scenario end
    },
    // ... add more steps for further interactions
];

describe("Client with Mocked Server", () => {
    let client: WhaTSClient;
    let authState: GenericAuthState;

    beforeAll(async () => {
        // 1. Start the Mock Server
        mockServer = createMockServer({
            port: mockServerPort,
            logger: console, // Use your preferred logger
            scenarioProvider: (sessionId: string) => {
                console.log(`[Test Setup] Providing scenario for session ${sessionId}`);
                // Return the scenario for this test session
                // You could potentially have different scenarios based on test needs
                return loginScenario;
            },
        });
        await mockServer.start();

        // 2. Initialize Client Auth (ensure it's fresh or matches scenario expectations)
        authState = await GenericAuthState.init(); // Use a fresh state for mock tests
        // If simulating login *to an existing account*, pre-populate creds:
        // authState.creds.me = { id: "9876543210@s.whatsapp.net" };
        // authState.creds.registered = true;
        // ... other necessary creds

        // 3. Create Client Instance pointing to Mock Server
        client = createWAClient({
            auth: authState,
            logger: console,
            wsOptions: { // Configure client to use the mock server URL
                url: new URL(`ws://localhost:${mockServerPort}/ws`), // Match mock server config
                // Optional: adjust timeouts if needed for testing
            },
        });
    });

    afterAll(() => {
        // 4. Stop the Mock Server
        mockServer?.stop();
        // Optional: Close client connection explicitly if needed
        // client.ws?.close();
    });

    test("Client should connect and simulate successful login", async () => {
        // Pre-condition for login scenario: Client thinks it's registered
        authState.creds.me = { id: "9876543210@s.whatsapp.net" };
        authState.creds.registered = true;

        let connectionOpened = false;
        let receivedSuccess = false; // Flag to check if <success> node led to 'open' state

        const openPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Connection open timeout")), 5000); // Add timeout
            client.addListener("connection.update", (update) => {
                console.log("[Client Update]", update);
                if (update.connection === "open") {
                    clearTimeout(timeout);
                    connectionOpened = true;
                    // Check if the JID was correctly adopted from the <success> node
                    expect(client.auth.creds.me?.id).toBe("9876543210@s.whatsapp.net");
                    receivedSuccess = true;
                    resolve();
                }
                if (update.connection === "close" && update.error) {
                    console.error("Client connection closed with error:", update.error);
                    clearTimeout(timeout);
                    reject(update.error); // Fail test if connection closes unexpectedly
                }
            });
        });

        try {
            // 5. Run the Client Connection logic
            await client.connect(); // This triggers the handshake with the mock
            await openPromise; // Wait for the 'open' state after scenario execution

            // 6. Assertions
            expect(connectionOpened).toBe(true);
            expect(receivedSuccess).toBe(true);
        } catch (err) {
            console.error("Test failed:", err);
            throw err; // Ensure test fails properly
        }
    }, 10000); // Test timeout
});

```

## Benefits

*   **Reliable:** Tests the logical protocol flow (handshake, XMPP nodes), not fragile encrypted bytes.
*   **Maintainable:** Scenarios are easier to understand and update than raw byte sequences. Less prone to breaking from minor WhatsApp changes.
*   **Deterministic:** Handshake simulation uses fixed mock keys, leading to predictable test runs.
*   **Flexible:** Allows testing various scenarios, error conditions, specific server responses, and different features by defining different `TestScenario` arrays.
*   **Debuggable:** Failures point to logical errors in the client or scenario mismatches, aided by server logs.
*   **Reusable:** The mock server package can potentially test different WhatsApp client implementations.

## Disclaimer

This is a **mock server** intended solely for **testing purposes**. It does not implement the full functionality or security of the real WhatsApp server. Do not use it for production applications or to interact with real user accounts.