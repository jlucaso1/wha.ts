# @wha.ts/debug

Debugging and instrumentation tools for the wha.ts core library.

## Overview

This package provides a centralized debug controller, data taps via hooks into core modules, circular buffer storage for various event types, and agent-friendly interfaces (REPL and a structured JSON API). These tools are designed for advanced debugging, troubleshooting, and integration with AI agents like LLMs to analyze application behavior.

## Structure

- `src/controller.ts`: Main `DebugController` class, orchestrates data collection and access.
- `src/datastore.ts`: `DebugDataStore` using circular buffers for efficient event storage (network, client events, errors, component states).
- `src/hooks.ts`: Functions to attach/detach hooks to `@wha.ts/core` modules, reporting data to the `DebugController`.
- `src/types.ts`: TypeScript interfaces defining the structure of debug events, states, and commands.
- `src/repl/`: A command-line REPL for human or LLM-driven interactive debugging.
- `src/api/`: A structured JSON API server for programmatic access to debug data, suitable for LLMs or external tools.
- `src/index.ts`: Main entry point, including an `initDebugController` helper.

## Usage

1.  **Initialization**:
    In your main application setup, initialize the `DebugController`. You'll need to pass instances of your core `wha.ts` components for the hooks to attach to.

    ```typescript
    import { createWAClient } from "@wha.ts/core";
    // ... other core imports

    import {
        initDebugController,
        startDebugREPL,
        startDebugAPIServer,
        type WhaTsCoreModules,
    } from "@wha.ts/debug";
    // Make sure to correctly define and export WhaTsCoreModules from @wha.ts/debug/hooks
    // or from your core package if it exposes these internals.

    async function main() {
        // ... your client setup ...
        const client = createWAClient({ /* ... */ });

        // You need to make core internal instances accessible to the debug package.
        // This might involve exposing them via getters on your WhaTSClient or ConnectionManager.
        const coreModules: WhaTsCoreModules = {
            // Example: these are illustrative paths and need to match your actual structure
            wsClient: (client as any).connectionManager?.ws,
            frameHandler: (client as any).connectionManager?.frameHandler,
            noiseProcessor: (client as any).connectionManager?.noiseProcessor,
            connectionManager: (client as any).connectionManager,
            authenticator: (client as any).authenticator,
            client: client,
            messageProcessor: (client as any).messageProcessor,
            // decodeBinaryNode: decodeBinaryNode, // if needed by hooks
        };

        const debugController = initDebugController(
            {
                networkLogCapacity: 500, // Customize buffer sizes
                clientEventCapacity: 200,
            },
            coreModules, // This attaches the hooks automatically
        );

        // Optionally start REPL or API server
        if (process.env.DEBUG_REPL === "true") { // Check environment variable or config
            console.log("Starting Debug REPL...");
            startDebugREPL(debugController);
        }
        if (process.env.DEBUG_API === "true") { // Check environment variable or config
            console.log("Starting Debug API Server...");
            startDebugAPIServer({ controller: debugController, port: 7999 });
        }

        // ... rest of your application
        await client.connect();
    }

    main();
    ```

2.  **Interacting**:
    *   **REPL**: If started, connect to the REPL for interactive commands.
    *   **API**: If started, make HTTP requests to `http://localhost:7999` (or your configured port).

---

## LLM Agent Debugging Guide for wha.ts

This section provides instructions for an LLM agent to effectively use the `@wha.ts/debug` tools to diagnose issues within the `wha.ts` application.

**Objective**: To guide the LLM in requesting specific information from the debug interfaces (REPL or API) and analyzing the returned data to identify root causes of problems.

**Prerequisites for the LLM**:
1.  The `@wha.ts/debug` package is integrated into the `wha.ts` application as shown in the "Usage" section above.
2.  The LLM has a mechanism to:
    *   Formulate commands for the REPL or construct HTTP API requests.
    *   Receive the output from these commands/requests (typically provided by a human operator or an intermediate tool).

**Key Debugging Interfaces & How to Use Them**:

### 1. Interactive REPL (`startDebugREPL`)

The REPL provides a command-line interface. The LLM should instruct the operator to execute commands and provide the full output.

**Core REPL Commands**:

*   `help`
    *   **Purpose**: Lists all available commands and their basic syntax.
    *   **LLM Action**: Start with this if unsure.
    *   **Output**: A help text string.

*   `logs network [count=N] [direction=send|receive|all] [layer=L]`
    *   **Purpose**: Retrieve network events.
    *   `count`: (Optional, default 10) Number of recent events.
    *   `direction`: (Optional, default all) Filter by `send` or `receive`.
    *   `layer`: (Optional, default all) Filter by network layer:
        *   `websocket_raw`: Raw bytes over WebSocket.
        *   `frame_raw`: Raw 3-byte length prefixed Noise protocol frames (before/after Noise encryption for handshake, after for transport).
        *   `noise_payload`: Plaintext payload *before* Noise encryption (send) or *after* Noise decryption (receive).
        *   `xmpp_node`: Decoded XMPP Stanzas (BinaryNode objects).
    *   **LLM Action**: Request specific network logs. E.g., "Show the last 5 received `xmpp_node` logs" -> `logs network 5 receive xmpp_node`.
    *   **Output**: Formatted string list of network events, including timestamp, direction, layer, length, data (potentially truncated or summarized for display, hex/base64 for binary), and any errors or metadata.

*   `logs events [count=N] [name=EVENT_NAME] [source=COMPONENT_NAME]`
    *   **Purpose**: Retrieve client-side application events.
    *   `count`: (Optional, default 10) Number of recent events.
    *   `name`: (Optional) Filter by a specific event name (e.g., `connection.update`, `message.received`).
    *   `source`: (Optional) Filter by the source component (e.g., `WhaTSClient`, `Authenticator`, `ConnectionManager`).
    *   **LLM Action**: Request client events. E.g., "Show last 3 `connection.update` events from `Authenticator`" -> `logs events 3 connection.update Authenticator`.
    *   **Output**: Formatted string list of client events, including timestamp, source, event name, and payload.

*   `logs errors [count=N]`
    *   **Purpose**: Retrieve recorded errors.
    *   `count`: (Optional, default 10) Number of recent errors.
    *   **LLM Action**: "Show the last 5 errors." -> `logs errors 5`.
    *   **Output**: Formatted string list of errors, including timestamp, source, message, stack (if available), and context.

*   `state list`
    *   **Purpose**: Lists all components for which state is being tracked.
    *   **LLM Action**: Use this to discover what component states can be inspected.
    *   **Output**: A list of component IDs (strings).

*   `state <componentId>`
    *   **Purpose**: Get the latest recorded state snapshot for a given component.
    *   `componentId`: The ID of the component (e.g., `authenticator`, `noiseProcessor`, `connectionManager`).
    *   **LLM Action**: "Get the current state of the `authenticator`." -> `state authenticator`.
    *   **Output**: Formatted string of the component's state snapshot, including timestamp and the state data (JSON-like).

*   `statehist <componentId> [count=N]`
    *   **Purpose**: Get the recent history of state snapshots for a component.
    *   `componentId`: The ID of the component.
    *   `count`: (Optional, default 5) Number of recent state snapshots.
    *   **LLM Action**: "Show the last 3 state changes for `noiseProcessor`." -> `statehist noiseProcessor 3`.
    *   **Output**: Formatted string list of state snapshots.

*   `clear <network|events|errors|state|all> [componentId_for_state]`
    *   **Purpose**: Clears the specified logs or state history. Useful for isolating events around a specific action.
    *   **LLM Action**: "Clear all network logs before I try to send a message." -> `clear network`. "Clear state history for `authenticator`." -> `clear state authenticator`.
    *   **Output**: Confirmation message.

*   `exit`
    *   **Purpose**: Closes the REPL.
    *   **LLM Action**: Instruct operator if debugging session is complete.

### 2. Structured JSON API (`startDebugAPIServer`)

The API server (default: `http://localhost:7999`) provides data in JSON format, which is ideal for programmatic consumption by an LLM agent.

**Core API Endpoints**:

*   `GET /logs/network?count=N&direction=D&layer=L`
    *   **Purpose**: Similar to `logs network` REPL command.
    *   **Parameters**: `count` (number), `direction` (string: "send"|"receive"), `layer` (string: "websocket_raw"|"frame_raw"|"noise_payload"|"xmpp_node").
    *   **LLM Action**: Construct URL and request. E.g., `http://localhost:7999/logs/network?count=5&direction=receive&layer=xmpp_node`.
    *   **Output**: JSON array of `NetworkEvent` objects. Binary data (`Uint8Array`) in `data` field will be Base64 encoded.

*   `GET /logs/events?count=N&name=EVENT_NAME&source=COMPONENT_NAME`
    *   **Purpose**: Similar to `logs events` REPL command.
    *   **Parameters**: `count` (number), `name` (string), `source` (string).
    *   **LLM Action**: Construct URL.
    *   **Output**: JSON array of `ClientEventRecord` objects.

*   `GET /logs/errors?count=N`
    *   **Purpose**: Similar to `logs errors` REPL command.
    *   **Parameters**: `count` (number).
    *   **LLM Action**: Construct URL.
    *   **Output**: JSON array of `ErrorRecord` objects.

*   `GET /state/list`
    *   **Purpose**: Similar to `state list` REPL command.
    *   **LLM Action**: Request this endpoint.
    *   **Output**: JSON array of component ID strings.

*   `GET /state/:componentId`
    *   **Purpose**: Similar to `state <componentId>` REPL command.
    *   **Path Parameter**: `componentId` (string).
    *   **LLM Action**: Construct URL. E.g., `http://localhost:7999/state/authenticator`.
    *   **Output**: JSON `ComponentStateSnapshot` object or 404.

*   `GET /statehist/:componentId?count=N`
    *   **Purpose**: Similar to `statehist <componentId>` REPL command.
    *   **Path Parameter**: `componentId` (string). Query Parameter: `count` (number).
    *   **LLM Action**: Construct URL.
    *   **Output**: JSON array of `ComponentStateSnapshot` objects or 404.

*   `POST /clear`
    *   **Purpose**: Similar to `clear` REPL command.
    *   **Request Body (JSON)**: `{ "type": "network" | "events" | "errors" | "state" | "all", "componentId"?: "string_if_type_is_state" }`
    *   **LLM Action**: Construct POST request with JSON body.
    *   **Output**: JSON confirmation: `{ "message": "Cleared..." }`.

**Debugging Strategies for LLM**:

1.  **Understand the Problem**:
    *   LLM should first ask for a clear description of the issue (e.g., "QR code not appearing," "messages not sending," "crashing on receiving a specific message type").
    *   Ask about steps to reproduce the issue.

2.  **Formulate a Hypothesis**: Based on the problem, form an initial idea of what might be wrong (e.g., "Network connection issue," "Authentication state incorrect," "Error during message encryption").

3.  **Systematic Data Collection**:
    *   **General Health Check**:
        *   Start by checking recent errors: `logs errors 5` (REPL) or `GET /logs/errors?count=5` (API).
        *   Check recent client events: `logs events 10` (REPL) or `GET /logs/events?count=10` (API), look for connection updates or relevant component events.
    *   **Isolate the Issue**:
        *   Instruct the operator to `clear all` logs.
        *   Instruct the operator to perform the action that triggers the bug.
        *   Immediately after, request relevant logs.
    *   **Trace Data Flow**:
        *   **Network**: Examine `websocket_raw`, then `frame_raw`, then `noise_payload`, then `xmpp_node` in sequence for both `send` and `receive` directions to see where data might be getting lost or corrupted. Pay close attention to `length` fields and `error` fields in `NetworkEvent`s.
        *   **Timestamps**: Correlate timestamps across different logs (network, events, errors) to build a timeline.
    *   **Inspect State**:
        *   Check the state of relevant components (`state <componentId>`) before and after the problematic operation.
        *   For instance, if authentication fails, check `state authenticator`. If Noise handshake is suspected, `state noiseProcessor`.

4.  **Analyze Data and Refine Hypothesis**:
    *   The LLM receives the data from the REPL/API.
    *   **Look for**:
        *   Error messages in any log.
        *   Unexpected event sequences or missing events.
        *   Network data that looks malformed (e.g., incorrect lengths, unexpected content at a given layer).
        *   XMPP stanzas that are incorrect or receive unexpected responses.
        *   Component states that are not what they should be (e.g., `authenticator.creds.registered` is `false` when it should be `true`).
        *   Discrepancies between sent and received data.
    *   Based on the analysis, update the hypothesis and request more specific data.

5.  **Iterate**: Repeat steps 3 and 4 until the root cause is likely identified or narrowed down significantly.

**Example LLM Debugging Scenario: "QR Code Not Appearing"**

1.  **LLM Request**: "Operator, please clear all logs using the REPL: `clear all`."
2.  **LLM Request**: "Now, please try to initiate the connection process that should display the QR code."
3.  **(After operator action)**
4.  **LLM Request**: "Please provide the output of the following REPL commands:
    *   `logs errors 5`
    *   `logs events 10 Authenticator connection.update` (or `GET /logs/events?count=10&source=Authenticator&name=connection.update`)
    *   `logs network 10 receive xmpp_node` (or `GET /logs/network?count=10&direction=receive&layer=xmpp_node`)
    *   `state authenticator`"
5.  **(LLM receives data)**
6.  **LLM Analysis**:
    *   *If errors*: Analyze error messages.
    *   *If `connection.update` events show `qr` is `null` or missing*: This confirms the issue.
    *   *If XMPP logs show no incoming `iq` stanza with `pair-device`*: The server might not be sending the QR refs.
    *   *If `authenticator` state shows an unexpected internal state (e.g., `FAILED` early)*: This points to an internal authenticator logic issue.
7.  **LLM Follow-up (example)**: "The `connection.update` event for the Authenticator did not contain a QR string. Let's examine the raw network traffic around the time the QR code was expected. Please provide: `logs network 10 receive websocket_raw` focusing on messages received after the handshake clientHello was sent."

**Tips for the LLM Agent**:
*   **Be Specific**: Request specific log types, counts, and filters. Vague requests yield too much data.
*   **Correlate Timestamps**: This is crucial for understanding event order.
*   **Iterate**: Don't expect to find the issue with one request. Debugging is a process of narrowing down.
*   **Ask for State Before & After**: If an operation is failing, get the state of relevant components immediately before and after attempting the operation.
*   **Binary Data**: Remember that binary data in API responses (like `NetworkEvent.data` if it was `Uint8Array`) will be Base64 encoded. The LLM may need to note this or request a hex representation if available through REPL.
*   **State Hypotheses**: Clearly state what you are looking for and why, so the operator can confirm if the data matches your expectations.
---

## Inspecting Signal Protocol State

The debug API and hooks provide deep inspection of Signal protocol state, including session records and identity keys.

### MCP Endpoints

- `GET /state/signal/sessions`:  
  Returns a list of component IDs for active Signal sessions (e.g., `["signal:session:12345@s.whatsapp.net.0", ...]`).  
  Use these IDs with the `/state/{componentId}` or `/statehist/{componentId}` endpoints.

- `GET /state/signal/identity`:  
  Returns the client's own Signal identity information (registration ID, identity key, prekeys).

- `GET /state/{componentId}` and `GET /statehist/{componentId}`:  
  Use with component IDs like `signal:session:PROTOCOL_ADDRESS_STRING` or `signal:identity` to inspect current or historical Signal state.

### Output Format

- All `Uint8Array` values (such as keys, signatures, etc.) within state objects are represented as Base64 strings in the JSON output.
- Full `SessionRecord` objects can be large, especially with many message keys.

### Example LLM Interactions

- To check all Signal sessions being tracked:  
  `GET /state/signal/sessions`
- To get current Signal session state for `12345@s.whatsapp.net.0`:  
  `GET /state/signal:session:12345@s.whatsapp.net.0`
- To check our own Signal identity:  
  `GET /state/signal/identity`
- Look for fields like `rootKey`, `ephemeralKeyPair`, `chainKey.counter`, `messageKeys` in the session state to understand the ratchet and message encryption/decryption status.

### Security Note

Private keys and sensitive cryptographic material are exposed via this debug interface for deep debugging. Use only in controlled environments.