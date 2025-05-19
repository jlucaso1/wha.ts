# The WhatsApp Noise Protocol Implementation

## 1. Introduction

This document describes the specific instance of the Noise Protocol Framework used by WhatsApp Web/Desktop clients, as implemented in the `wha.ts` library. It aims to clarify the handshake process, cryptographic choices, and message formats used to establish a secure end-to-end encrypted channel between the client and the WhatsApp servers. This implementation uses the `XX` handshake pattern.

## 2. Overview

WhatsApp utilizes the Noise Protocol Framework to secure the WebSocket connection used for communication. The process involves:

1.  **Handshake Phase:** An initial exchange of messages based on the `XX` handshake pattern. Parties exchange ephemeral Diffie-Hellman (DH) public keys and optionally their static public keys. They perform a sequence of DH operations, hashing the results incrementally into a shared secret key (`ck`) and updating a handshake hash (`h`).
2.  **Transport Phase:** After the handshake, derived symmetric keys are used with an AEAD cipher (AES-GCM) to encrypt/decrypt subsequent messages (WhatsApp's binary XML nodes) exchanged over the WebSocket connection.

The specific Noise protocol variant used is **`Noise_XX_25519_AESGCM_SHA256`**.

## 3. Handshake State Machine

Each party (client and server) maintains a state during the handshake, conceptually similar to the Noise `HandshakeState`. Key variables within the `wha.ts` `NoiseProcessor` map to Noise concepts:

*   **`s` (Local Static Key Pair):** Corresponds to `creds.noiseKey`. This is the long-term identity key pair of the client.
*   **`e` (Local Ephemeral Key Pair):** Corresponds to `creds.pairingEphemeralKeyPair`. Generated per connection attempt.
*   **`rs` (Remote Static Public Key):** The server's static public key, received and decrypted during the handshake (`serverHello.static`).
*   **`re` (Remote Ephemeral Public Key):** The server's ephemeral public key, received during the handshake (`serverHello.ephemeral`).
*   **`h` (Handshake Hash):** Managed internally by `NoiseProcessor` (`state.handshakeHash`). It incorporates the `protocol_name` (`Noise_XX_...`), the prologue (`WA_HEADER`), public keys exchanged, and ciphertexts of encrypted handshake messages. Updated via `mixIntoHandshakeHash`.
*   **`ck` (Chaining Key):** Managed internally by `NoiseProcessor` (`state.salt`). This variable evolves throughout the handshake as DH results are mixed in. It's used as the HKDF salt. Updated via `mixKeys`.
*   **`k` (Cipher Key):** Managed internally by `NoiseProcessor` (`state.encryptionKey`, `state.decryptionKey`). Initialized from `h`, then updated via `mixKeys` after each DH operation during the handshake. Used by the `CipherState` equivalent for encrypting/decrypting handshake payloads (`s`, payloads) and static keys.
*   **`n` (Nonce):** Managed internally by `NoiseProcessor` (`state.writeCounter`, `state.readCounter`). Incremented after each encryption/decryption operation using the current `k`. Reset to 0 when `k` changes.

## 4. Cryptographic Primitives

The `wha.ts` implementation instantiates the Noise framework with the following cryptographic functions:

*   **DH Functions (Curve25519):**
    *   `GENERATE_KEYPAIR()`: Uses `Curve.generateKeyPair()` based on `curve25519-js`.
    *   `DH(key_pair, public_key)`: Uses `Curve.sharedKey()` based on `curve25519-js`. Handles potential prefix byte (0x05) on public keys.
    *   `DHLEN`: 32 bytes.

*   **Cipher Functions (AES256-GCM):**
    *   `ENCRYPT(k, n, ad, plaintext)`: Uses `aesEncryptGCM` from `@wha.ts/utils.ts` (based on `@noble/ciphers`).
    *   `DECRYPT(k, n, ad, ciphertext)`: Uses `aesDecryptGCM` from `@wha.ts/utils.ts`.
    *   **Nonce Format:** An 8-byte (64-bit) counter `n` is encoded into a 12-byte IV. The first 8 bytes are zero, and the last 4 bytes contain the big-endian representation of `n` (as seen in `generateIV` within `NoiseProcessor` and `generateNonceIV` in `crypto.ts`).
    *   **AEAD:** AES-256-GCM provides 16 bytes of authentication data (tag).
    *   `REKEY(k)`: Although the function exists in `CipherState`, the provided code doesn't show explicit rekeying during the transport phase. The default HKDF-based rekeying would likely apply if used.

*   **Hash Functions (SHA256):**
    *   `HASH(data)`: Uses `sha256` from `@wha.ts/utils.ts` (based on `@noble/hashes`).
    *   `HASHLEN`: 32 bytes.
    *   `BLOCKLEN`: 64 bytes.
    *   `HKDF(chaining_key, input_key_material, num_outputs)`: Uses the `hkdf` function from `@wha.ts/utils.ts` (based on `@noble/hashes/hkdf`). The `chaining_key` corresponds to the `salt` parameter, and `input_key_material` is the `buffer` parameter. Info is typically empty (`""`). `num_outputs` is implicitly 2 (for `MixKey`) or handled by slicing the 64-byte output (for `Split`).

## 5. Processing Rules

The `wha.ts` implementation follows the Noise processing rules tailored for the `XX` handshake pattern. The logic is primarily within `NoiseProcessor` and orchestrated by `ConnectionManager`.

*   **Initialization (`Initialize`):**
    *   Performed within the `NoiseProcessor` constructor and `ConnectionManager.initializeConnectionComponents`.
    *   `protocol_name`: Set implicitly to `Noise_XX_25519_AESGCM_SHA256`.
    *   `InitializeSymmetric`: `h` and `ck` are initialized to `HASH(protocol_name)`.
    *   `MixHash(prologue)`: The prologue (`WA_HEADER`) is mixed into `h`.
    *   `MixHash(initiator_static_public_key)`: The client's static public key (`creds.noiseKey.publicKey`) is mixed into `h`.
    *   `initiator`: Set to `true` (client role).
    *   `s`: Set to `creds.noiseKey`.
    *   `e`: Set to `creds.pairingEphemeralKeyPair`.
    *   `rs`, `re`: Initially empty.
    *   `message_patterns`: Set to the sequence corresponding to `XX`: `("e")`, `("e", "ee", "s", "es")`, `("s", "se")`.

*   **Writing/Reading Messages (`WriteMessage`/`ReadMessage`):**
    *   Handled by `ConnectionManager` interacting with `NoiseProcessor` and `FrameHandler`.
    *   **Message 1 (`-> e`):**
        *   `WriteMessage`: Client (`initiator=true`) processes "e". The `pairingEphemeralKeyPair` (`e`) is already generated. Its public key is included in a `ClientHello` protobuf message. `MixHash(e.public_key)` is performed implicitly within `NoiseProcessor` constructor (as it hashes the static key which is *not* 'e', but the logic applies). *Correction: The 'e' token means generate a new ephemeral, write it, and hash it. The `wha.ts` code uses a pre-generated `pairingEphemeralKeyPair` for the connection attempt. It writes this key. The hash mixing happens in the `processHandshake` logic when the *remote* 'e' is processed.*
        *   The `ClientHello` protobuf is serialized.
        *   `EncryptAndHash(payload)`: The serialized protobuf is the payload. Since `k` is still empty, it's not encrypted. `MixHash(payload)` is not explicitly shown for this first message. *Correction: The `framePayload` function wraps the message, but `encryptMessage` is only called if handshake is finished. Handshake messages themselves are not encrypted until a DH happens.*
        *   The framed message is sent via WebSocket.
    *   **Message 2 (`<- e, ee, s, es`):**
        *   `ReadMessage`: Client receives the `ServerHello` protobuf message via `handleDecryptedFrame` -> `handleHandshakeData` -> `noiseProcessor.processHandshake`.
        *   Token "e": Read `serverHello.ephemeral` into `re`. Call `MixHash(re.public_key)`.
        *   Token "ee": Call `MixKey(DH(e, re))`. This updates `ck` (`salt`) and `k` (`encryptionKey`, `decryptionKey`), resets `n` (counters).
        *   Token "s": Read `serverHello.static`. Since `k` is now non-empty, call `DecryptAndHash()` on it to get the server's static public key (`rs`). Verify the associated certificate chain within the decrypted payload.
        *   Token "es": Call `MixKey(DH(e, rs))`. Updates `ck`, `k`, resets `n`.
        *   `DecryptAndHash(payload)`: Decrypt `serverHello.payload` (containing `CertChain`) using the latest `k` and `n`. Call `MixHash()` on the ciphertext.
    *   **Message 3 (`-> s, se`):**
        *   `WriteMessage`: Client continues within `handleHandshakeData`.
        *   Token "s": Encrypt client's static public key (`s.public_key`) using `EncryptAndHash()`. This forms `clientFinish.static`.
        *   Token "se": Call `MixKey(DH(s, re))`. Updates `ck`, `k`, resets `n`.
        *   `EncryptAndHash(payload)`: Encrypt the `ClientPayload` protobuf using the latest `k` and `n`. This forms `clientFinish.payload`. Call `MixHash()` on the ciphertext.
        *   The `ClientFinish` protobuf is serialized and sent, framed.
        *   `Split()`: Call `noiseProcessor.finalizeHandshake()`. This performs `HKDF(ck, zerolen, 2)` to derive the final transport encryption keys (`c1.k`, `c2.k`) and initializes two `CipherState` equivalents (implicitly managed by `NoiseProcessor`'s state after `isHandshakeFinished` becomes true).

*   **Transport Messages:**
    *   After `Split()`, `ConnectionManager.sendNode` encodes the binary node, `FrameHandler.framePayload` calls `noiseProcessor.encryptMessage` (using the initiator's sending key, `c1.k`), frames it, and sends it.
    *   Incoming transport frames are decrypted by `FrameHandler.handleReceivedData` calling `noiseProcessor.decryptMessage` (using the initiator's receiving key, `c2.k`), then decoded by `decodeBinaryNode`.

## 6. Message Format

*   **Framing:** All WebSocket messages (handshake and transport) are prefixed with a 3-byte big-endian length field indicating the length of the following encrypted Noise message payload (`FrameHandler`).
*   **Handshake Messages:** The content *before* encryption/decryption within the Noise process consists of serialized Protobuf messages:
    *   Message 1 Payload: `HandshakeMessage` containing `ClientHello` (with initiator's ephemeral public key).
    *   Message 2 Payload: `HandshakeMessage` containing `ServerHello` (with responder's ephemeral public key, encrypted static key, and encrypted `CertChain` payload).
    *   Message 3 Payload: `HandshakeMessage` containing `ClientFinish` (with encrypted initiator's static key and encrypted `ClientPayload`).
*   **Transport Messages:** The plaintext payloads processed by `EncryptAndHash`/`DecryptAndHash` after the handshake are the WhatsApp binary XML nodes (encoded using `encodeBinaryNode`).

## 7. Prologue

The prologue is a fixed byte sequence mixed into the initial handshake hash (`h`) by both parties.
`NOISE_WA_HEADER = new Uint8Array([87, 65, 6, 2])` (ASCII "WA" + Version 6.2).

## 8. Handshake Pattern (`XX`)

The implementation uses the `XX` pattern:

```
XX:
  -> e
  <- e, ee, s, es
  -> s, se
```

*   **Initiator (`-> e`):** Sends its ephemeral public key (`ClientHello`).
*   **Responder (`<- e, ee, s, es`):** Sends its ephemeral (`e`), performs DH (`ee`), sends its encrypted static key (`s`), performs DH (`es`), and sends an encrypted payload (`CertChain`). All within `ServerHello`.
*   **Initiator (`-> s, se`):** Sends its encrypted static key (`s`), performs DH (`se`), and sends an encrypted payload (`ClientPayload`). All within `ClientFinish`.

This pattern provides mutual authentication if static keys are verified (client verifies server cert, server implicitly verifies client via successful decryption of `ClientPayload` after `se` DH).

## 9. Handshake Payloads

*   **`ClientHello` Payload:** Implicitly empty (contains only initiator's ephemeral key).
*   **`ServerHello` Payload:** Contains the `CertChain` protobuf, encrypted after the `es` token. Used by the client to verify the server's identity.
*   **`ClientFinish` Payload:** Contains the `ClientPayload` protobuf (with registration/login info), encrypted after the `se` token. Used by the server to authenticate and register/log in the client.

## 10. Protocol Name

The effective protocol name used for initialization is:
**`Noise_XX_25519_AESGCM_SHA256`**

## 11. Security Considerations (WhatsApp Context)

*   **Authentication:** Server authentication relies on the client verifying the `CertChain` received in Message 2 against expected values (e.g., issuer serial matching `WA_CERT_DETAILS.SERIAL`). Client authentication relies on the server successfully decrypting the `ClientPayload` in Message 3, which requires knowledge derived from the client's static key (`noiseKey`) via the `se` DH operation.
*   **Static Key Pinning:** While not explicit in the Noise handshake itself, the application layer often pins the server's static key (`rs`) after the first successful connection to detect MITM attacks on subsequent connections.
*   **Framing Security:** The 3-byte length prefix ensures message boundaries can be determined before decryption attempts.
*   **Protobuf Payloads:** Using Protobuf adds structure but also potential parsing complexity compared to raw payloads.
*   **Certificate Validation:** The security relies heavily on the correct implementation of the certificate validation logic within `processHandshake`.
*   **(No PSK):** This core handshake does not use Pre-Shared Keys.
*   **Nonce Handling:** The 64-bit counter provides a vast space, making nonce reuse extremely unlikely in practice for typical session durations.
*   **Data Volume Limits:** AES-GCM has theoretical limits, but these are unlikely to be reached by the control messages exchanged over this channel.