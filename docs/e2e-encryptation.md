# End-to-End Encryption (E2EE) in Wha.ts: Current Implementation State

## 1. Overview

This document outlines the current implementation status of End-to-End Encryption (E2EE) based on the Signal Protocol within the `wha.ts` library, specifically focusing on the `@wha.ts/signal` package. It details the components built, the approach taken, and the parts that are still pending or require integration.

The core cryptographic logic for Signal Protocol (X3DH-like session setup and Double Ratchet) has been implemented **from scratch** within the `SignalManager`. However, crucial pieces like fetching recipient keys and integrating this manager into the main client workflow are **not yet complete**.

## 2. Prerequisites (Still Required for Full Functionality)

The existing `wha.ts` codebase should ideally handle:

*   **WebSocket Connection:** Establishing and maintaining the raw WebSocket connection (`packages/core/src/transport/websocket.ts`). (Seems Present)
*   **Noise Protocol Handshake & Framing:** Encrypting/decrypting the transport layer using the Noise protocol (`NoiseProcessor`, `FrameHandler`) and handling WhatsApp's binary framing. (Seems Present)
*   **Binary Node Encoding/Decoding:** Parsing the decrypted Noise frames into structured `BinaryNode` objects (`@wha.ts/binary`). (Seems Present)
*   **Basic State Management:** Storing and retrieving core authentication credentials (`IAuthStateProvider`, `AuthenticationCreds`) including identity keys and pre-keys via `@wha.ts/core/src/state/interface.ts`. (Seems Present)

## 3. Core Components Status

Implementing E2EE requires several key components:

1.  **Signal Protocol Engine:**
    *   **Status:** **Implemented (from scratch)**.
    *   **Details:** Unlike integrating an external library, the core cryptographic operations of the Signal Protocol (X3DH for setup, Double Ratchet for ongoing sessions) have been implemented directly within `packages/signal/src/signal-manager.ts`. This uses cryptographic primitives (Curve25519, AES-GCM, HKDF, HMAC-SHA256) provided by the `@wha.ts/utils` package. Internal structures like `SignalSession` and `SignalChain` manage the session state.

2.  **`ISignalProtocolManager` Interface:**
    *   **Status:** **Defined and Implemented**.
    *   **Location:** `packages/signal/src/interface.ts`
    *   **Details:** Defines the contract for interacting with the Signal Protocol logic. Key methods implemented in `SignalManager`:
        ```typescript
        interface ISignalProtocolManager {
          /**
           * Encrypts plaintext for a recipient. Handles session lookup, creation (X3DH), and Double Ratchet.
           * Requires pre-key bundle fetching for new sessions (currently unimplemented).
           * Returns the ciphertext and type ('pkmsg' or 'msg'). The ciphertext for 'msg' includes an appended MAC.
           */
          encryptMessage(recipientJid: string, plaintext: Uint8Array): Promise<EncryptedSignalMessage>; // EncryptedSignalMessage contains { type: 'pkmsg' | 'msg', ciphertext: Uint8Array }

          /**
           * Decrypts an incoming PreKeySignalMessage (parsed proto). Establishes a session.
           * Returns the decrypted inner plaintext payload.
           */
          decryptPreKeyMessage(senderJid: string, preKeyMsg: PreKeySignalMessage): Promise<Uint8Array>;

          /**
           * Decrypts an incoming regular SignalMessage (parsed proto) using an existing session.
           * Returns the decrypted inner plaintext payload. Does *not* handle MAC verification internally.
           */
          decryptRegularMessage(senderJid: string, signalMsg: SignalMessage): Promise<Uint8Array>;
        }
        ```
        *(Note: Actual return types and parameters match the code in `interface.ts`)*

3.  **`SignalManager` Class:**
    *   **Status:** **Implemented**.
    *   **Location:** `packages/signal/src/signal-manager.ts`
    *   **Dependencies:** `IAuthStateProvider`, `ILogger`.
    *   **Responsibilities:**
        *   Implements `ISignalProtocolManager`.
        *   Performs core Signal cryptographic operations (X3DH setup, Double Ratchet).
        *   Uses `async-mutex` for concurrent access control per JID (`runWithSessionLock`).
        *   Loads/saves session state (`SignalSession` object) as a `Uint8Array` blob using `JSON.stringify/parse` with `BufferJSON` reviver/replacer via `IAuthStateProvider.keys.get/set('session', [jid])`.
        *   Loads local identity/pre-keys from `IAuthStateProvider.creds`.
        *   Loads/saves remote identity keys via `IAuthStateProvider.keys`.
        *   Handles logic for creating `pkmsg` vs `msg`.
        *   **MAC Handling:** Appends an 8-byte truncated HMAC-SHA256 MAC to the *end* of the serialized `SignalMessage` protobuf for regular messages during encryption. MAC verification during decryption is **not handled** within the `decryptUsingSession` method itself.
        *   **PreKey Bundle:** Includes a call to `fetchPreKeyBundle`, but this method is currently a **placeholder** returning dummy data and needs proper implementation (requires IQ requests to the server).

## 4. Implementation Steps Status

### Step 1: Implement/Integrate the Signal Protocol Engine

*   **Status:** **Done (Implemented from scratch)**.
*   The core logic resides in `SignalManager` using `@wha.ts/utils` for crypto.

### Step 2: Update State Management

*   **Status:** **Done**.
*   `ISignalProtocolStore` and `IAuthStateProvider` in `packages/core/src/state/interface.ts` include the necessary `session: Uint8Array` type in `SignalDataTypeMap`.
*   `GenericSignalKeyStore` (in `generic-auth-state.ts`) handles storing/retrieving this `Uint8Array` data, serialized as JSON.

### Step 3: Integrate Decryption into Message Flow

*   **Status:** **Incomplete / Integration Missing**.
*   The `SignalManager` methods (`decryptPreKeyMessage`, `decryptRegularMessage`) are implemented.
*   However, the necessary modifications to `Authenticator.handleNodeReceived` (in `packages/core/src/core/authenticator.ts`) to:
    *   Identify encrypted message nodes (`<enc type='pkmsg'>` or `<enc type='msg'>`).
    *   Parse the content into `PreKeySignalMessage` or `SignalMessage` protos.
    *   Call the appropriate `signalManager.decrypt*` method.
    *   Handle the returned plaintext (pass to `handleDecryptedMessageContent`).
    *   **Perform MAC verification** for regular messages (since `SignalManager` doesn't do it).
    *   Handle decryption errors.
*   ...are **not present** in the provided codebase snippets and are assumed to be missing.

### Step 4: Decode Inner Message Content

*   **Status:** **Not Implemented / Responsibility of Caller**.
*   The `SignalManager` returns the decrypted `Uint8Array` payload (expected to be the inner Protobuf, e.g., `waE2E.Message`).
*   The subsequent step of parsing this inner proto (`fromBinary(waE2EMessageSchema, decryptedPayload)`) and dispatching high-level events (like `message.upsert`) needs to be handled by the code *calling* the `SignalManager`'s decryption methods (likely `Authenticator.handleDecryptedMessageContent`, which is also not shown).

### Step 5: Integrate Encryption/Sending Flow

*   **Status:** **Incomplete / Integration Missing / Blocked**.
*   `SignalManager.encryptMessage` is implemented and handles session management and Double Ratchet encryption.
*   **Blocker:** Sending the *first* message (`pkmsg`) to a contact **is not currently possible** because `fetchPreKeyBundle` is unimplemented.
*   The high-level client methods (e.g., `WhaTSClient.sendMessageText`) that would:
    *   Construct the inner `waE2E.Message` proto.
    *   Call `signalManager.encryptMessage`.
    *   Construct the outer `message` `BinaryNode` with the `<enc>` child.
    *   Use `connectionActions.sendNode`.
*   ...are **not present** in the provided codebase snippets and are assumed to be missing.

## 5. Data Storage Summary (`IAuthStateProvider`)

The auth state provider (`GenericAuthState`) manages:

*   **`creds` (Directly in `AuthenticationCreds`):** Noise key, identity key, signed pre-key, registration ID, ADV key, `me`, `account`, etc. (Seems complete for basic auth).
*   **`keys` (Via `ISignalProtocolStore` - `GenericSignalKeyStore`):**
    *   `pre-key:<LOCAL_JID>:<KEY_ID>` -> `KeyPair` (Local pre-keys).
    *   `signed-identity-key:<REMOTE_JID>:<DEVICE_ID>` -> `KeyPair` (Remote identity keys).
    *   `signed-pre-key:<REMOTE_JID>:<DEVICE_ID>` -> `SignedKeyPair` (Remote signed pre-key - likely unused currently).
    *   **`session:<REMOTE_JID>:<DEVICE_ID>` -> `Uint8Array` (Stores serialized `SignalSession` JSON blob for remote contacts).** <-- **Implemented**

## 6. Key Challenges & Considerations (Current State)

*   **PreKey Bundle Fetching:** Implementing `fetchPreKeyBundle` is **critical** for initiating new E2EE sessions (sending the first message). This requires sending specific IQ stanzas and parsing the response. **(BLOCKER)**
*   **Integration with Authenticator/Client:** The `SignalManager` needs to be correctly integrated into the `Authenticator` for receiving/decrypting messages and into the `WhaTSClient` (or similar) for sending encrypted messages. This involves handling node parsing, calling manager methods, and processing results. **(MISSING)**
*   **MAC Verification:** The decryption flow in the `Authenticator` needs to implement MAC verification for regular messages, as it's not handled within `SignalManager.decryptUsingSession`.
*   **Inner Protobuf Handling:** The client needs logic to encode/decode the actual WhatsApp message content (e.g., `waE2E.Message`) before encryption and after decryption.
*   **Error Handling:** Robust error handling for decryption failures (MAC errors, counter issues, missing sessions) and encryption failures (missing keys) needs to be implemented in the integration layer.
*   **From-Scratch Implementation Risk:** Maintaining a custom Signal Protocol implementation requires careful attention to cryptographic details and compatibility with WhatsApp's potentially evolving standards.
*   **WhatsApp Updates:** Changes by WhatsApp to binary formats, encryption parameters, or protocol specifics can break the implementation.

This updated document provides a clearer picture of the E2EE implementation status in `wha.ts` based on the provided code. The core crypto is present, but significant work remains on key fetching and integration.