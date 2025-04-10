# Wha.ts Inspector - Chrome Extension (Proof of Concept)

## 1. Purpose

The Wha.ts Inspector is a Chrome browser extension designed as a **developer tool** to aid in understanding the WebSocket communication used by WhatsApp Web. It leverages the decoding capabilities of the `wha.ts` library to intercept and analyze the binary messages exchanged between the browser and WhatsApp servers.

**Note:** This extension is currently in a **Proof-of-Concept (POC)** stage. Its primary function is logging intercepted data to the browser's developer console.

## 2. Current State & Features (POC)

The current POC version focuses on demonstrating the feasibility of intercepting WebSocket traffic within the WhatsApp Web page context:

*   **WebSocket Interception:** Injects a content script into `https://web.whatsapp.com/` that monkey-patches the native `WebSocket` object.
*   **Traffic Logging:** Captures raw binary data sent (`send`) and received (`message`) by the WebSocket connection.
*   **Console Output:** Logs detailed information about each intercepted message directly to the **main browser Developer Console** (accessible via F12).
*   **Log Formatting:** Uses `console.groupCollapsed` to organize logs for better readability.
*   **Data Display:** For each message, logs:
    *   Direction (⬆️ SEND / ⬇️ RECV)
    *   Timestamp
    *   Data Type (e.g., `ArrayBuffer`)
    *   Total message size in bytes.
    *   A snippet of the raw data in Base64 format.
    *   A snippet of the raw data in Hexdump format.
*   **Framing Analysis:** Attempts to read the first 3 bytes of `ArrayBuffer` data as the Big Endian frame length header used by WhatsApp. Logs:
    *   The length declared in the header.
    *   The calculated payload size (Total Size - 3 bytes).
    *   A hexdump snippet of the *calculated payload* (data after the first 3 bytes).
*   **Initial Handshake Decoding:**
    *   Attempts to decode the *payload* of the first few intercepted messages using the `HandshakeMessage` Protobuf schema from `wha.ts`.
    *   If successful, logs the decoded handshake message structure as JSON. This helps visualize the initial Noise protocol exchange (`ClientHello`, `ServerHello`).
*   **Manual Decoding Placeholder:** Includes a function `window.decodeWhaTsNode(dataString, format?)` callable from the console. This is intended for *manually* pasting **decrypted** standard WhatsApp binary node data (as hex or base64) for decoding using `wha.ts`'s `decodeBinaryNode`. **Note:** This currently requires manually bundling `decodeBinaryNode` into the extension.

## 3. How It Works

*   **Manifest V3:** Built as a standard Chrome Manifest V3 extension.
*   **Content Script:** The core logic resides in `content.js` (built from `content_entry.ts`).
    *   **Injection:** Injected into the `MAIN` world of `web.whatsapp.com` at `document_start` to ensure WebSocket patching occurs before WhatsApp's scripts initialize fully.
    *   **Patching:** Modifies `WebSocket.prototype.send` and `WebSocket.prototype.addEventListener`/`onmessage` to intercept calls and events.
    *   **Bundling:** Uses `esbuild` (via `build.mjs`) to bundle TypeScript code, `protobuf-es`, and necessary `wha.ts` modules (currently `HandshakeMessageSchema` and utils) into the final `content.js`.
    *   **Logging:** Uses standard `console` methods for output.

## 4. Installation & Usage (POC)

1.  **Prerequisites:** Node.js and npm installed.
2.  **Clone:** Clone the `wha.ts` repository (or get the extension source code).
3.  **Navigate:** Open a terminal in the extension's directory (e.g., `wha-ts-inspector-console-poc`).
4.  **Install Dependencies:** Run `npm install`.
5.  **Build:** Run `node build.mjs`. This creates the `dist/` directory containing the bundled `content.js`.
6.  **Load Extension:**
    *   Open Chrome and navigate to `chrome://extensions/`.
    *   Enable "Developer mode".
    *   Click "Load unpacked".
    *   Select the extension's directory (the one containing `manifest.json` and the `dist` folder).
7.  **Open WhatsApp Web:** Navigate to `https://web.whatsapp.com/` and log in if needed. Reload the page after enabling the extension.
8.  **Open Console:** Open the browser's Developer Console (F12 and select the "Console" tab).
9.  **Observe:** Watch the console for logs prefixed with `[Wha.ts POC ...]`. Expand the collapsed groups to see details about sent/received WebSocket messages, including the attempted handshake decoding.
10. **Manual Decode (Optional):** If you have *decrypted* binary node data (e.g., from other debugging methods) as a hex string `HEX_DATA`, you can try `decodeWhaTsNode('HEX_DATA')` in the console (requires `decodeBinaryNode` to be bundled).

## 5. Future Improvements & Roadmap

This POC lays the groundwork for a more powerful debugging tool. Planned enhancements include:

*   **Full Binary Node Decoding:** Integrate `wha.ts`'s primary `decodeBinaryNode` function and necessary dependencies (constants, reader, etc.) into the bundle so the manual `decodeWhaTsNode` works correctly.
*   **Noise Key Extraction:** The most significant challenge. Research and implement techniques to reliably extract the ephemeral Noise protocol session keys (encryption/decryption keys, counters, handshake hash) from the WhatsApp Web JavaScript environment's memory. This likely involves:
    *   Advanced module discovery (adapting `moduleRaid` or similar).
    *   Deep inspection of WhatsApp Web's internal state objects.
*   **Automatic Decryption:** Once Noise keys can be extracted, implement logic (based on `wha.ts`'s `NoiseProcessor`) to automatically decrypt the payload of intercepted messages *after* the handshake is complete.
*   **Automatic Binary Node Decoding:** After successful automatic decryption, pass the plaintext payload to `decodeBinaryNode` and display the structured node automatically.
*   **DevTools Panel UI:** Re-introduce a dedicated DevTools panel (`panel.html`, `panel.js`, `devtools.js`) for a cleaner and more interactive user interface, replacing console logging.
*   **Node Tree Visualization:** Display decoded binary nodes in a collapsible tree format within the DevTools panel.
*   **Filtering & Searching:** Add capabilities to filter and search through the captured messages in the panel UI.
*   **Improved State Management:** Track the Noise handshake state and connection status more formally within the extension.
*   **Robust Error Handling:** Enhance error handling during patching, interception, and decoding.
*   **Configuration Options:** Potentially allow users to configure aspects like log verbosity or specific features.

## 6. Limitations & Challenges

*   **Decryption Difficulty:** Automatically decrypting post-handshake messages is **the primary challenge** due to the difficulty of accessing the in-memory Noise session keys from an extension's content script. **The current POC does not automatically decrypt encrypted messages.**
*   **Fragility:** Relying on monkey-patching native browser objects and accessing internal WhatsApp Web structures makes the extension inherently fragile. Updates to WhatsApp Web can easily break the interception or key extraction logic.
*   **Performance:** While minimal in the POC, intensive processing or logging of every message could potentially impact WhatsApp Web's performance in a full-featured version.
*   **Security:** Injecting code into a sensitive application like WhatsApp Web requires careful consideration of security implications.

## 7. Contributing

Contributions are welcome! If you're interested in helping tackle the challenges, particularly around Noise key extraction and building out the UI/decoding features, please refer to the main `wha.ts` contributing guidelines and consider opening an issue or pull request.

## 8. Disclaimer

This tool is intended for educational and development purposes only. It is not affiliated with or endorsed by WhatsApp/Meta. Using unofficial tools to interact with WhatsApp may violate their Terms of Service and carries a risk of account suspension. Use at your own risk.