import { decodeBinaryNode } from "../src/binary/decode"; // Assuming this returns a specific type, e.g., DecodedNode
import { fromBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  HandshakeMessageSchema, // Assuming these are MessageType instances
  ClientPayloadSchema,
} from "../src/gen/whatsapp_pb";
import { bytesToBase64, bytesToHex } from "../src/utils/bytes-utils";
import type { GenMessage } from "@bufbuild/protobuf/codegenv1";

// --- Type Definitions ---

// Define a potential type for the decoded node if not explicitly exported
// Replace 'any' with the actual structure if known
type DecodedNode = {
  tag: string;
  attrs: Record<string, string>;
  content?: DecodedNode[] | Uint8Array | string | null;
};

// Extend Window interface for the custom decode function
declare global {
  interface Window {
    decodeWhaTsNode?: (
      inputData: string,
      format?: "hex" | "base64"
    ) => Promise<void>;
  }
}

// Extend WebSocket interface for custom properties added during patching
declare global {
  interface WebSocket {
    _whaTsPatched?: boolean;
    _whaTsOriginalOnMessage?:
      | ((this: WebSocket, ev: MessageEvent) => any)
      | null;
    _whaTsWrappedOnMessageGetterValue?:
      | ((this: WebSocket, ev: MessageEvent) => any)
      | null; // Store the wrapper for the getter
  }
}

// --- Constants ---
const WA_WEB_HELLO_PREFIX = new Uint8Array([0x57, 0x41, 0x06, 0x03]); // WA\x06\x03
const WA_DEFAULT_PREFIX = new Uint8Array([0x57, 0x41, 0x06, 0x02]); // WA\x06\x02
const LENGTH_PREFIX_SIZE = 3;
const WA_BINARY_NODE_PREFIX = new Uint8Array([0x00, 0x00]); // Example, adjust if needed

// List of Protobuf schemas to try for decoding
// Ensure these conform to the MessageType interface from @bufbuild/protobuf
const PROTO_SCHEMAS: GenMessage<any>[] = [
  HandshakeMessageSchema,
  ClientPayloadSchema,
];

console.log("[Wha.ts Console POC] Content script injected.");

// --- Utility Functions ---

/**
 * Checks if the start of a Uint8Array matches a specific prefix.
 */
function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

// --- Protobuf Decoding Helpers ---

/**
 * Attempts to decode raw bytes using a list of known Protobuf schemas.
 * Returns the first successful decoding result (as JSON) or null.
 */
function tryDecodeWithKnownSchemas(
  payloadBytes: Uint8Array
): { schemaName: string; decoded: JsonValue } | null {
  if (!payloadBytes || payloadBytes.length === 0) {
    return null; // Nothing to decode
  }

  for (const schema of PROTO_SCHEMAS) {
    try {
      // Use fromBinary which throws on error according to bufbuild docs
      const message = fromBinary(schema, payloadBytes);
      // Convert to JSON for logging. toJson returns JsonValue
      return { decoded: toJson(schema, message), schemaName: schema.typeName };
    } catch (error) {
      // Error suggests this schema didn't match or data is corrupt/encrypted
      // console.debug(`[Wha.ts POC] Failed to decode payload as ${schema.typeName}:`, error);
      continue; // Try the next schema
    }
  }

  // If no schema matched
  return null;
}

// --- Data Interception and Logging ---

/**
 * Logs intercepted WebSocket data, attempting to parse framing and decode Protobuf/Binary Nodes.
 * @param direction - "send" or "receive"
 * @param data - The data intercepted from WebSocket (ArrayBuffer, Blob, string, etc.)
 */
async function logInterceptedData(
  direction: "send" | "receive",
  data: unknown
): Promise<void> {
  const timestamp = new Date().toLocaleTimeString();
  const arrow = direction === "send" ? "⬆️ SEND" : "⬇️ RECV";
  let dataSize = 0;
  let dataType: string = typeof data; // Initialize with typeof
  let frameHeaderLength = -1; // Length declared in the 3-byte header
  let extractedPayloadLength = -1; // Actual length of extracted payload bytes
  let fullFrameBytes: Uint8Array | null = null; // Hold Uint8Array version of the full frame
  let payloadBytes: Uint8Array | null = null; // Hold extracted payload bytes
  let detectedPrefixStr: string | null = null;
  let headerOffset = 0; // Where the 3-byte length header starts
  let payloadOffset = 0; // Where the actual payload starts

  // Start Collapsed Group
  console.groupCollapsed(
    `%c[Wha.ts POC @ ${timestamp}] %c${arrow}`,
    "color: #888; font-weight: normal;",
    direction === "send"
      ? "color: blue; font-weight: bold;"
      : "color: green; font-weight: bold;"
  );

  try {
    // --- Data Type Handling & Initial Processing ---
    if (data instanceof ArrayBuffer) {
      dataSize = data.byteLength;
      dataType = "ArrayBuffer"; // More specific type
      fullFrameBytes = new Uint8Array(data); // Convert for processing

      // --- Detect Prefix and Set Offsets ---
      // Check for known prefixes to determine where the length header starts
      if (
        direction === "send" &&
        hasPrefix(fullFrameBytes, WA_WEB_HELLO_PREFIX)
      ) {
        detectedPrefixStr = `WA_WEB_HELLO_PREFIX (${bytesToHex(
          WA_WEB_HELLO_PREFIX
        )})`;
        headerOffset = WA_WEB_HELLO_PREFIX.length;
        payloadOffset = headerOffset + LENGTH_PREFIX_SIZE;
        console.log(
          "[Wha.ts POC] Detected initial send frame prefix (WA_WEB_HELLO_PREFIX)."
        );
      } else if (hasPrefix(fullFrameBytes, WA_DEFAULT_PREFIX)) {
        // Standard prefix, might appear on send or receive after handshake
        detectedPrefixStr = `WA_DEFAULT_PREFIX (${bytesToHex(
          WA_DEFAULT_PREFIX
        )})`;
        // Assuming standard prefix doesn't shift the header/payload structure
        headerOffset = 0; // Length header expected at the start
        payloadOffset = LENGTH_PREFIX_SIZE;
        // Note: If WA_DEFAULT_PREFIX *itself* contains the length, adjust offsets accordingly.
        // Based on common patterns, often a fixed prefix exists *before* the length.
        // Re-adjust if analysis shows WA_DEFAULT_PREFIX includes the length:
        // headerOffset = WA_DEFAULT_PREFIX.length;
        // payloadOffset = headerOffset + LENGTH_PREFIX_SIZE;
      }
      // Add checks for other potential prefixes (e.g., Noise routing 'ED') if needed
      // else if (hasPrefix(fullFrameBytes, SOME_OTHER_PREFIX)) { ... }
      else {
        // Default: Assume no special prefix, length starts at byte 0
        headerOffset = 0;
        payloadOffset = LENGTH_PREFIX_SIZE;
        detectedPrefixStr = null; // No known prefix identified at the start
      }

      // --- De-framing Logic (Using Determined Offsets) ---
      if (dataSize >= headerOffset + LENGTH_PREFIX_SIZE) {
        const view = new DataView(data, headerOffset, LENGTH_PREFIX_SIZE);
        // WhatsApp uses Big Endian for frame length (3 bytes)
        frameHeaderLength = (view.getUint8(0) << 16) | view.getUint16(1, false); // Read 3 bytes BE

        const expectedPayloadStart = payloadOffset;
        const availableDataForPayload = dataSize - expectedPayloadStart;

        // Sanity check the declared length
        if (frameHeaderLength < 0 || frameHeaderLength > 20 * 1024 * 1024) {
          // e.g., > 20MB threshold
          console.warn(
            `[Wha.ts POC] Frame header length (${frameHeaderLength}) seems invalid or unusually large. Framing logic might be incorrect or data corrupted. Offset: ${headerOffset}`
          );
          frameHeaderLength = -1; // Mark as invalid
          extractedPayloadLength = -1;
        } else if (availableDataForPayload >= frameHeaderLength) {
          // We have enough data for the declared payload length
          extractedPayloadLength = frameHeaderLength;
          payloadBytes = fullFrameBytes.slice(
            expectedPayloadStart,
            expectedPayloadStart + extractedPayloadLength
          );
        } else {
          // Declared length exceeds available data after header
          console.warn(
            `[Wha.ts POC] Declared payload length (${frameHeaderLength}) ` +
              `exceeds available data (${availableDataForPayload}) ` +
              `after calculated payload offset (${expectedPayloadStart}). Buffer size: ${dataSize}. Possible fragmentation or incorrect framing.`
          );
          // Attempt to extract what's available, might be truncated/incorrect
          extractedPayloadLength =
            availableDataForPayload > 0 ? availableDataForPayload : 0;
          if (extractedPayloadLength > 0) {
            payloadBytes = fullFrameBytes.slice(expectedPayloadStart);
          } else {
            payloadBytes = null; // No payload data available
          }
        }
      } else {
        console.warn(
          `[Wha.ts POC] Data too short (${dataSize} bytes) for framing info (expected header at offset ${headerOffset}).`
        );
        frameHeaderLength = -1; // Indicate failure
        extractedPayloadLength = -1;
      }
    } else if (data instanceof Blob) {
      dataSize = data.size;
      dataType = "Blob"; // More specific type
      console.log(
        `%cType: %cBlob (%c${data.type}%c)`,
        "color: black;",
        "font-weight: bold;",
        "color: #555;",
        "color: black;"
      );
      // Note: To process Blob content, you'd need data.arrayBuffer() which is async
      // We are currently only logging metadata for Blobs.
    } else if (typeof data === "string") {
      dataSize = data.length;
      dataType = "string";
      console.log("%cType: %cstring", "color: black;", "font-weight: bold;");
      console.log(
        "%cContent Snippet:",
        "color: black;",
        data.substring(0, 100) + (data.length > 100 ? "..." : "")
      );
    } else {
      // Handle null, undefined, or other unexpected types
      dataType =
        data === null
          ? "null"
          : data === undefined
          ? "undefined"
          : Object.prototype.toString.call(data);
      dataSize = 0; // Size is not applicable or unknown
      console.log(
        "%cType: %c%s",
        "color: black;",
        "font-weight: bold;",
        dataType
      );
    }

    // --- Log General Details ---
    console.log(
      `%cTotal Size:%c ${dataSize} bytes`,
      "color: black;",
      "font-weight: normal;"
    );
    if (detectedPrefixStr) {
      console.log(
        `%cDetected Prefix:%c ${detectedPrefixStr}`,
        "color: #666;",
        "font-family: monospace; color: #666;"
      );
    }
    if (frameHeaderLength !== -1) {
      console.log(
        `%cFrame Header Length (at offset ${headerOffset}):%c ${frameHeaderLength}`,
        "color: black;",
        "font-weight: normal;"
      );
      console.log(
        `%cExtracted Payload Length (at offset ${payloadOffset}):%c ${extractedPayloadLength}`,
        "color: black;",
        "font-weight: bold;"
      );
    } else if (dataType === "ArrayBuffer") {
      console.log(
        "%cFraming Info:%c Could not read valid length header.",
        "color: orange;",
        "color: gray;"
      );
    }

    // --- Log Hex/Base64 Snippets (Full Frame if ArrayBuffer) ---
    if (fullFrameBytes) {
      // Only log snippets if we have the bytes
      const snippetLength = 128; // Limit snippet size
      console.log(
        "%cBase64 Snippet (Full Frame):%c %s...",
        "color: black;",
        "font-family: monospace;",
        bytesToBase64(fullFrameBytes.slice(0, snippetLength))
      );
      console.log(
        "%cHexdump Snippet (Full Frame):%c %s...",
        "color: black;",
        "font-family: monospace;",
        bytesToHex(fullFrameBytes.slice(0, snippetLength))
      );
    }

    // --- Attempt Payload Decoding ---
    if (payloadBytes && payloadBytes.length > 0) {
      const payloadSnippetLength = 128; // Limit snippet size
      console.log(
        "%cPayload Hexdump Snippet:%c %s...",
        "color: black;",
        "font-family: monospace;",
        bytesToHex(payloadBytes.slice(0, payloadSnippetLength))
      );

      // Check for Binary Node prefix (e.g., \x00\x00) - adjust if needed
      // Note: This check should happen on the *payload*, not the full frame bytes.
      if (fullFrameBytes && hasPrefix(fullFrameBytes, WA_BINARY_NODE_PREFIX)) {
        console.log(
          "%cPayload Type:%c Detected Binary Node Prefix (%s). Manual decode needed (use decodeWhaTsNode).",
          "color: brown; font-weight: bold;",
          "color: gray;",
          bytesToHex(WA_BINARY_NODE_PREFIX)
        );
        // Optionally, attempt binary decode here if desired, but manual tool is provided. Needs to decrypt the payload.
        // try {
        //    const decoded = await decodeBinaryNode(payloadBytes); // Ensure decodeBinaryNode exists
        //    console.log("%cDecoded Binary Node:", "color: purple;", decoded);
        // } catch (binErr) {
        //    console.error("Failed auto-decoding binary node:", binErr);
        // }
      } else {
        // Attempt Protobuf decoding if not a binary node
        const decodeResult = tryDecodeWithKnownSchemas(payloadBytes);
        if (decodeResult) {
          console.log(
            `%cSuccessfully Decoded Payload As:%c ${decodeResult.schemaName}`,
            "color: purple; font-weight: bold;",
            "font-family: monospace; color: purple;"
          );
          console.dir(decodeResult.decoded); // Use console.dir for better object inspection
        } else {
          console.log(
            "%cProto Decode Attempt:%c Failed (Likely encrypted, binary node, or unknown format)",
            "color: orange;",
            "color: gray;"
          );
        }
      }
    } else if (dataType === "ArrayBuffer") {
      if (extractedPayloadLength === 0) {
        console.log(
          "%cPayload Info:%c Payload length is zero.",
          "color: orange;",
          "color: gray;"
        );
      } else if (extractedPayloadLength === -1 && frameHeaderLength !== -1) {
        // We failed to extract payload likely due to insufficient data vs frame length
        console.log(
          "%cPayload Info:%c Could not extract payload (declared length exceeded available data).",
          "color: red;",
          "color: gray;"
        );
      } else if (extractedPayloadLength === -1) {
        // We failed to extract payload likely due to inability to read frame header
        console.log(
          "%cPayload Info:%c Could not extract payload (framing header issue).",
          "color: red;",
          "color: gray;"
        );
      }
    } else if (dataType !== "Blob" && dataType !== "string") {
      // Already handled Blob/String logging
      console.log(
        "%cPayload Info:%c Cannot extract payload from this data type.",
        "color: orange;",
        "color: gray;"
      );
    }
  } catch (e) {
    console.error(
      "[Wha.ts Console POC] Error processing data for logging:",
      e,
      data
    );
    console.log("%cError processing log data.", "color: red;");
  } finally {
    // End Group
    console.groupEnd();
  }
}

// --- Manual Decode Function (Exposed on Window) ---

/**
 * Decodes a Hex or Base64 string input using the decodeBinaryNode function.
 * Assumes the input is *only* the decrypted payload bytes of a binary node.
 * @param inputData - The data string (hex or base64 encoded).
 * @param format - The format of inputData ("hex" or "base64"). Defaults to "hex".
 */
globalThis.decodeWhaTsNode = async function (
  inputData: string,
  format: "hex" | "base64" = "hex"
): Promise<void> {
  console.log(
    `Attempting manual decode (format: ${format}). Input length: ${inputData.length}`
  );

  // Check if the actual decode function is available
  if (typeof decodeBinaryNode !== "function") {
    console.error(
      "ERROR: `decodeBinaryNode` function is not available. Ensure 'wha.ts' source is correctly bundled and exported."
    );
    return;
  }

  let nodeBytes: Uint8Array;
  try {
    if (format === "base64") {
      const binaryString = globalThis.atob(inputData); // Decode base64
      nodeBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        nodeBytes[i] = binaryString.charCodeAt(i);
      }
    } else {
      // Assume hex
      if (inputData.startsWith("0x")) inputData = inputData.substring(2); // Remove optional 0x prefix
      inputData = inputData.replace(/\s+/g, ""); // Remove whitespace
      if (inputData.length % 2 !== 0) {
        throw new Error("Hex string must have an even number of characters.");
      }
      if (!/^[0-9a-fA-F]*$/.test(inputData)) {
        throw new Error("Hex string contains invalid characters.");
      }
      nodeBytes = new Uint8Array(inputData.length / 2);
      for (let i = 0; i < inputData.length; i += 2) {
        nodeBytes[i / 2] = parseInt(inputData.substring(i, i + 2), 16);
      }
    }
    console.log("Converted input to bytes:", nodeBytes);
  } catch (e) {
    console.error(
      "Error converting input string to bytes:",
      e instanceof Error ? e.message : e
    );
    return;
  }

  if (nodeBytes.length === 0) {
    console.warn("Input data converted to zero bytes. Nothing to decode.");
    return;
  }

  try {
    // IMPORTANT: decodeBinaryNode expects ONLY the node data,
    // NOT the 3-byte frame header or any prefix. Provide the *decrypted payload*.
    const decodedNode: DecodedNode = await decodeBinaryNode(nodeBytes); // Use the defined type
    console.log(
      "%cSuccessfully Decoded Node:",
      "color: purple; font-weight: bold;",
      decodedNode
    );
    // Pretty print for easier inspection
    console.log(
      JSON.stringify(
        decodedNode,
        (key, value) => {
          // Custom replacer to handle non-serializable types nicely
          if (value instanceof Uint8Array) {
            // Show length and a hex snippet for buffers
            const hexSnippet = bytesToHex(value.slice(0, 16)); // Show first 16 bytes
            return `Uint8Array[${value.length}](${hexSnippet}${
              value.length > 16 ? "..." : ""
            })`;
          }
          if (typeof value === "bigint") {
            // Convert BigInt to string for JSON compatibility
            return value.toString();
          }
          return value; // Keep other values as is
        },
        2 // Indentation level
      )
    );
  } catch (e) {
    console.error("Manual Decode Failed:", e);
    // Log the bytes that failed to decode for debugging
    console.error("Failed on bytes:", bytesToHex(nodeBytes));
  }
};
console.log(
  "[Wha.ts Console POC] Manual decode function available as `decodeWhaTsNode(dataString, format?)`. Provide DECRYPTED payload data only (no framing/prefix)."
);

// --- WebSocket Patching ---

try {
  const originalWebSocket = globalThis.WebSocket;
  // Check flag using optional chaining and nullish coalescing for safety
  if (originalWebSocket.prototype._whaTsPatched ?? false) {
    console.log("[Wha.ts Console POC] WebSocket already patched. Skipping.");
  } else {
    console.log("[Wha.ts Console POC] Attempting to patch WebSocket...");

    // --- Patch send ---
    const originalSend = originalWebSocket.prototype.send;
    originalWebSocket.prototype.send = function (
      data: Parameters<typeof originalSend>[0]
    ): void {
      // Use stricter type for data based on original send method signature
      logInterceptedData("send", data).catch((err) =>
        console.error("[Wha.ts POC] Error logging sent data:", err)
      );
      // Use Reflect.apply for robust context handling
      return Reflect.apply(originalSend, this, [data]);
    };
    console.log("[Wha.ts Console POC] Patched send.");

    // --- Patch addEventListener ---
    const originalAddEventListener =
      originalWebSocket.prototype.addEventListener;
    originalWebSocket.prototype.addEventListener = function <
      K extends keyof WebSocketEventMap
    >(
      type: K,
      listener:
        | ((this: WebSocket, ev: WebSocketEventMap[K]) => any)
        | EventListenerObject
        | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (type === "message" && listener) {
        // Only wrap 'message' listeners
        const originalListener = listener; // Keep reference

        // Create the wrapper function / object
        const wrappedListener = (event: MessageEvent): void => {
          // Log first (async, fire-and-forget)
          logInterceptedData("receive", event?.data).catch((err) =>
            console.error(
              "[Wha.ts POC] Error logging received data (addEventListener):",
              err
            )
          );
          // Safely call the original listener
          try {
            if (typeof originalListener === "function") {
              // Use Reflect.apply for functions
              Reflect.apply(originalListener, this, [event]);
            } else if (originalListener?.handleEvent) {
              // Call handleEvent for EventListenerObjects
              originalListener.handleEvent.call(originalListener, event);
            }
          } catch (e) {
            console.error(
              "[Wha.ts Console POC] Error in original message listener (addEventListener):",
              e
            );
          }
        };

        // Call the original addEventListener with the wrapper
        Reflect.apply(originalAddEventListener, this, [
          type,
          wrappedListener,
          options,
        ]);
      } else {
        // For other event types, or if listener is null, call original directly
        Reflect.apply(originalAddEventListener, this, [
          type,
          listener,
          options,
        ]);
      }
    };
    console.log("[Wha.ts Console POC] Patched addEventListener.");

    // --- Patch onmessage setter ---
    const onmessageDescriptor = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "onmessage"
    );

    if (onmessageDescriptor?.set) {
      const originalOnMessageSetter = onmessageDescriptor.set;

      Object.defineProperty(WebSocket.prototype, "onmessage", {
        configurable: true, // Keep configurable if it was originally
        enumerable: true, // Keep enumerable if it was originally
        get: function (): ((this: WebSocket, ev: MessageEvent) => any) | null {
          // Return the wrapped listener if set, otherwise invoke original getter (if exists)
          return (
            this._whaTsWrappedOnMessageGetterValue ??
            (onmessageDescriptor.get
              ? onmessageDescriptor.get.call(this)
              : undefined)
          );
        },
        set: function (
          listener: ((this: WebSocket, ev: MessageEvent) => any) | null
        ): void {
          if (typeof listener === "function") {
            // Store the original listener for potential future use (e.g., unpatching)
            this._whaTsOriginalOnMessage = listener;

            // Create the wrapper
            const wrappedListener = (event: MessageEvent): void => {
              // Log first (async, fire-and-forget)
              logInterceptedData("receive", event?.data).catch((err) =>
                console.error(
                  "[Wha.ts POC] Error logging received data (onmessage):",
                  err
                )
              );
              // Safely call the original listener
              try {
                Reflect.apply(listener, this, [event]);
              } catch (e) {
                console.error(
                  "[Wha.ts Console POC] Error in original onmessage listener:",
                  e
                );
              }
            };

            // Store the wrapper to be returned by the getter
            this._whaTsWrappedOnMessageGetterValue = wrappedListener;
            // Call the original setter with the wrapper
            Reflect.apply(originalOnMessageSetter, this, [wrappedListener]);
          } else {
            // If setting null or non-function, clear our stored wrapper/original and call original setter
            this._whaTsOriginalOnMessage = null;
            this._whaTsWrappedOnMessageGetterValue = null;
            Reflect.apply(originalOnMessageSetter, this, [listener]);
          }
        },
      });
      console.log("[Wha.ts Console POC] Patched onmessage setter.");
    } else {
      console.warn(
        "[Wha.ts Console POC] Could not patch onmessage setter (descriptor or setter missing)."
      );
    }

    // --- Set Patched Flag ---
    // Use Object.defineProperty for non-enumerable property if preferred
    Object.defineProperty(originalWebSocket.prototype, "_whaTsPatched", {
      value: true,
      writable: false, // Make it read-only
      configurable: true, // Allow deletion/reconfiguration if needed later
      enumerable: false, // Hide it from for...in loops
    });
    // originalWebSocket.prototype._whaTsPatched = true; // Simpler alternative if enumerability isn't a concern

    console.log("[Wha.ts Console POC] WebSocket patching complete.");
  }
} catch (err) {
  console.error("[Wha.ts Console POC] Failed to patch WebSocket:", err);
}
