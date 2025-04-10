import { decodeBinaryNode } from "../src/binary/decode";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import {
  HandshakeMessageSchema,
  ClientPayloadSchema, // Import ClientPayload too, though less likely to be directly decoded from raw payload
} from "../src/gen/whatsapp_pb"; // Adjust path if needed

console.log("[Wha.ts Console POC] Content script injected.");

// --- Utilities (You might eventually import these from wha.ts or a shared util file) ---
function bytesToHex(
  bytes: string | any[] | Uint8Array<any>,
  maxLen = 64
): string {
  let hex = "";
  const len = Math.min(bytes.length, maxLen);
  for (let i = 0; i < len; i++) {
    const byte = bytes[i];
    hex += byte.toString(16).padStart(2, "0");
  }
  if (bytes.length > maxLen) {
    hex += "...";
  }
  return hex;
}

function arrayBufferToUint8Array(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

function arrayBufferToBase64Snippet(buffer: any, maxLength = 64): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = Math.min(bytes.byteLength, maxLength);
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  try {
    let base64 = window.btoa(binary);
    if (bytes.byteLength > maxLength) {
      base64 += "...";
    }
    return base64;
  } catch (e) {
    console.error(
      "[Wha.ts Console POC] Error converting ArrayBuffer snippet to Base64:",
      e
    );
    return "[Conversion Error]";
  }
}

// --- Protobuf Decoding Helpers ---

/**
 * Attempts to decode raw bytes using a specific Protobuf schema.
 * Returns the decoded object (as JSON for logging) or null if decoding fails.
 */
async function tryDecodeProto(
  payloadBytes: Uint8Array,
  schema: typeof HandshakeMessageSchema | typeof ClientPayloadSchema // Add other schemas here if needed
): Promise<object | null> {
  if (!payloadBytes || payloadBytes.length === 0) {
    return null; // Nothing to decode
  }
  try {
    const message = fromBinary(schema, payloadBytes);
    // Convert to a plain JSON object for easier console logging
    // Use toJson for better representation than default toString
    // @ts-ignore
    return toJson(schema, message, { emitDefaultValues: true });
  } catch (error) {
    // Log decoding errors only if you need deep debugging, otherwise it clutters the console
    // console.debug(`[Wha.ts POC] Failed to decode payload as ${schema.typeName}:`, error);
    return null; // Decoding failed, likely wrong schema or encrypted data
  }
}

/**
 * Tries decoding the payload with a list of known schemas.
 * Returns the first successful decoding result or null.
 */
async function tryDecodeWithKnownSchemas(
  payloadBytes: Uint8Array
): Promise<{ schemaName: string; decoded: object } | null> {
  // Try decoding as HandshakeMessage first, as it's common during handshake
  let decoded = await tryDecodeProto(payloadBytes, HandshakeMessageSchema);
  if (decoded) {
    return { schemaName: HandshakeMessageSchema.typeName, decoded };
  }

  // Add attempts for other schemas here if relevant for direct payload decoding
  // decoded = await tryDecodeProto(payloadBytes, ClientPayloadSchema);
  // if (decoded) {
  //     return { schemaName: ClientPayloadSchema.typeName, decoded };
  // }
  // Note: ClientPayload is usually *inside* an encrypted ClientFinish message payload,
  // so decoding the raw network payload directly as ClientPayload is unlikely to succeed after the initial ClientHello.

  return null; // None of the known schemas matched
}

// --- Log intercepted data helper (Improved with Proto Decoding Attempt) ---
async function logInterceptedData(direction: string, data: any) {
  // Make the function async
  const timestamp = new Date().toLocaleTimeString();
  const arrow = direction === "send" ? "⬆️ SEND" : "⬇️ RECV";
  let size = 0;
  let dataType = typeof data;
  let frameLength = -1;
  let payloadLength = -1;
  let dataBytes: Uint8Array | null = null; // Hold Uint8Array version
  let payloadBytes: Uint8Array | null = null; // Hold payload bytes specifically

  // Start Collapsed Group
  console.groupCollapsed(
    `%c[Wha.ts POC @ ${timestamp}] %c${arrow}`,
    "color: #888; font-weight: normal;",
    direction === "send"
      ? "color: blue; font-weight: bold;"
      : "color: green; font-weight: bold;"
  );

  try {
    if (data instanceof ArrayBuffer) {
      size = data.byteLength;
      // @ts-ignore
      dataType = "ArrayBuffer";
      dataBytes = arrayBufferToUint8Array(data); // Convert for processing

      // --- De-framing Logic ---
      if (size >= 3) {
        const view = new DataView(data);
        frameLength = (view.getUint8(0) << 16) | view.getUint16(1, false);
        const calculatedPayloadLength = size - 3;

        // Determine actual payload length and extract bytes
        if (frameLength === calculatedPayloadLength) {
          payloadLength = frameLength;
          payloadBytes = dataBytes.slice(3);
        } else {
          // Handle potential discrepancies (e.g., routing info prefix)
          // For simplicity in POC, let's prioritize the header length for now,
          // but acknowledge the mismatch. A more robust solution would handle the prefix.
          console.warn(
            `[Wha.ts POC] Frame length mismatch! Header: ${frameLength}, Actual: ${calculatedPayloadLength}. Using header length for payload.`
          );
          if (size >= 3 + frameLength) {
            payloadLength = frameLength;
            payloadBytes = dataBytes.slice(3, 3 + frameLength); // Slice based on header
          } else {
            console.error(
              `[Wha.ts POC] Cannot extract payload based on header length ${frameLength}, buffer too short (${size}).`
            );
            payloadLength = -1; // Indicate error
          }
        }
      } else {
        console.warn("[Wha.ts POC] Data too short for framing info.", data);
      }
    } else if (data instanceof Blob) {
      // ... (Blob handling remains the same) ...
      size = data.size;
      // @ts-ignore
      dataType = "Blob";
      console.log(
        `%cType: %cBlob (%c${data.type}%c)`,
        "color: black;",
        "font-weight: bold;",
        "color: #555;",
        "color: black;"
      );
    } else if (typeof data === "string") {
      // ... (String handling remains the same) ...
      size = data.length;
      dataType = "string";
      console.log("%cType: %cstring", "color: black;", "font-weight: bold;");
      console.log(
        "%cContent Snippet:",
        "color: black;",
        data.substring(0, 100) + (data.length > 100 ? "..." : "")
      );
    } else {
      // ... (Other type handling remains the same) ...
      // @ts-ignore
      dataType = data ? Object.prototype.toString.call(data) : "Empty/Null";
      console.log(
        "%cType: %c%s",
        "color: black;",
        "font-weight: bold;",
        dataType
      );
    }

    // Log General Details
    console.log(
      `%cTotal Size:%c ${size} bytes`,
      "color: black;",
      "font-weight: normal;"
    );
    if (frameLength !== -1) {
      console.log(
        `%cFrame Header Length:%c ${frameLength}`,
        "color: black;",
        "font-weight: normal;"
      );
      // Log calculated payload length based *only* on frame size - header size
      console.log(
        `%cCalculated Payload Length:%c ${size >= 3 ? size - 3 : "N/A"}`,
        "color: black;",
        "font-weight: normal;"
      );
      // Log the payload length we actually used for extraction
      if (payloadLength !== -1) {
        console.log(
          `%cExtracted Payload Length:%c ${payloadLength}`,
          "color: black;",
          "font-weight: bold;"
        );
      }
    }

    // Log Hex/Base64 Snippets (only if we have the full data bytes)
    if (dataBytes) {
      console.log(
        "%cBase64 Snippet (Full Frame):%c %s",
        "color: black;",
        "font-family: monospace;",
        arrayBufferToBase64Snippet(dataBytes.buffer)
      );
      console.log(
        "%cHexdump Snippet (Full Frame):%c %s",
        "color: black;",
        "font-family: monospace;",
        bytesToHex(dataBytes)
      );
    }

    // --- Attempt Proto Decode and Log Payload ---
    if (payloadBytes) {
      console.log(
        "%cPayload Hexdump Snippet:%c %s",
        "color: black;",
        "font-family: monospace;",
        bytesToHex(payloadBytes)
      );

      const decodeResult = await tryDecodeWithKnownSchemas(payloadBytes);
      if (decodeResult) {
        console.log(
          `%cSuccessfully Decoded Payload As:%c ${decodeResult.schemaName}`,
          "color: purple; font-weight: bold;",
          "font-family: monospace; color: purple;"
        );
        // console.dir is often better for objects than JSON.stringify in the console
        console.dir(decodeResult.decoded);
      } else {
        console.log(
          "%cProto Decode Attempt:%c Failed (Likely encrypted or unknown format)",
          "color: orange;",
          "color: gray;"
        );
      }
      // @ts-ignore
    } else if (dataBytes && dataType === "ArrayBuffer" && size < 3) {
      // Handle case where data is ArrayBuffer but too short for payload extraction
      console.log(
        "%cPayload Info:%c Too short to extract payload.",
        "color: orange;",
        "color: gray;"
      );
    } else if (
      // @ts-ignore
      dataType !== "ArrayBuffer" &&
      // @ts-ignore
      dataType !== "Blob" &&
      dataType !== "string"
    ) {
      // If it's not a type we can easily get bytes from
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
  }

  // End Group
  console.groupEnd();
}

// --- Manual Decode Placeholder ---
// This function needs the actual `decodeBinaryNode` logic to be bundled in.
// For now, it's just a placeholder demonstrating how you'd call it from the console.
// @ts-ignore
window.decodeWhaTsNode = async function (inputData: string, format = "hex") {
  console.log(
    `Attempting manual decode (format: ${format}). Input:`,
    inputData
  );
  // @ts-ignore (Check if the function exists, it might not be bundled)
  if (typeof decodeBinaryNode !== "function") {
    console.error(
      "ERROR: `decodeBinaryNode` function is not available. Ensure 'wha.ts' source is correctly bundled."
    );
    return;
  }

  let nodeBytes;
  try {
    if (format === "base64") {
      // Need base64ToBytes utility
      const binaryString = window.atob(inputData);
      nodeBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        nodeBytes[i] = binaryString.charCodeAt(i);
      }
    } else {
      // Assume hex
      if (inputData.length % 2 !== 0)
        throw new Error("Hex string must have an even length.");
      nodeBytes = new Uint8Array(inputData.length / 2);
      for (let i = 0; i < inputData.length; i += 2) {
        nodeBytes[i / 2] = parseInt(inputData.substring(i, i + 2), 16);
      }
    }
    console.log("Converted input to bytes:", nodeBytes);
  } catch (e) {
    console.error("Error converting input string to bytes:", e);
    return;
  }

  try {
    // IMPORTANT: decodeBinaryNode expects ONLY the node data,
    // NOT the 3-byte frame header. You must provide the *decrypted payload*.
    const decodedNode = await decodeBinaryNode(nodeBytes); // Assumes decodeBinaryNode is available
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
          if (value instanceof Uint8Array) {
            return `Uint8Array[${value.length}](${bytesToHex(value, 32)})`; // Show hex snippet for buffers
          }
          return value;
        },
        2
      )
    );
  } catch (e) {
    console.error("Manual Decode Failed:", e);
  }
};
console.log(
  "[Wha.ts Console POC] Manual decode function available as `decodeWhaTsNode(dataString, format?)`. Provide DECRYPTED payload data."
);

// --- Patch WebSocket ---
try {
  const originalWebSocket = window.WebSocket;
  // @ts-ignore
  if (originalWebSocket.prototype._whaTsPatched) {
    console.log("[Wha.ts Console POC] WebSocket already patched. Skipping.");
  } else {
    console.log("[Wha.ts Console POC] Attempting to patch WebSocket...");
    const originalSend = originalWebSocket.prototype.send;
    const originalAddEventListener =
      originalWebSocket.prototype.addEventListener;

    originalWebSocket.prototype.send = function (data) {
      // Call async logger but don't await here to avoid blocking send
      logInterceptedData("send", data).catch((err) =>
        console.error("[Wha.ts POC] Error logging sent data:", err)
      );
      return Reflect.apply(originalSend, this, [data]);
    };
    console.log("[Wha.ts Console POC] Patched send.");

    originalWebSocket.prototype.addEventListener = function (
      type: string,
      listener: any,
      options: any
    ) {
      // console.log(`[Wha.ts Console POC] DEBUG: addEventListener called for type: "${type}"`);
      if (type === "message") {
        // console.log('[Wha.ts Console POC] DEBUG: Wrapping "message" listener via addEventListener.');
        const originalListener = listener;
        const wrappedListener = (event: { data: any }) => {
          // Call async logger but don't await
          logInterceptedData(
            "receive",
            event ? event.data : "[No event data]"
          ).catch((err) =>
            console.error(
              "[Wha.ts POC] Error logging received data (addEventListener):",
              err
            )
          );
          try {
            // Safe call to original
            if (typeof originalListener === "function") {
              Reflect.apply(originalListener, this, [event]);
            } else if (originalListener?.handleEvent) {
              originalListener.handleEvent.call(originalListener, event);
            }
          } catch (e) {
            console.error(
              "[Wha.ts Console POC] Error in original message listener (addEventListener):",
              e
            );
          }
        };
        return Reflect.apply(originalAddEventListener, this, [
          type,
          wrappedListener,
          options,
        ]);
      } else {
        return Reflect.apply(originalAddEventListener, this, [
          type,
          listener,
          options,
        ]);
      }
    };
    console.log("[Wha.ts Console POC] Patched addEventListener.");

    // --- Patch 'onmessage' setter ---
    const onmessageDescriptor = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "onmessage"
    );
    if (onmessageDescriptor?.set) {
      const originalOnMessageSetter = onmessageDescriptor.set;
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        configurable: true,
        enumerable: true,
        get: function () {
          // console.log('[Wha.ts Console POC] DEBUG: Getting onmessage property.');
          return (
            this._whaTsWrappedOnMessageGetterValue ||
            (onmessageDescriptor.get
              ? onmessageDescriptor.get.call(this)
              : undefined)
          );
        },
        set: function (listener) {
          // console.log('[Wha.ts Console POC] DEBUG: Setting onmessage property.');
          if (typeof listener === "function") {
            this._whaTsOriginalOnMessage = listener; // Store original for potential future use/inspection
            const wrappedListener = (event: { data: any }) => {
              // Call async logger but don't await
              logInterceptedData(
                "receive",
                event ? event.data : "[No event data]"
              ).catch((err) =>
                console.error(
                  "[Wha.ts POC] Error logging received data (onmessage):",
                  err
                )
              );
              try {
                // Safe call to original
                Reflect.apply(listener, this, [event]);
              } catch (e) {
                console.error(
                  "[Wha.ts Console POC] Error in original onmessage listener:",
                  e
                );
              }
            };
            this._whaTsWrappedOnMessageGetterValue = wrappedListener; // Store wrapped one for the getter
            Reflect.apply(originalOnMessageSetter, this, [wrappedListener]); // Call original setter with wrapped
          } else {
            // If the listener is not a function (e.g., null), just pass it through
            this._whaTsWrappedOnMessageGetterValue = listener;
            Reflect.apply(originalOnMessageSetter, this, [listener]);
          }
        },
      });
      console.log("[Wha.ts Console POC] Patched onmessage setter.");
    } else {
      console.warn(
        "[Wha.ts Console POC] Could not patch onmessage setter (descriptor issue)."
      );
    }

    // @ts-ignore
    originalWebSocket.prototype._whaTsPatched = true;
    console.log("[Wha.ts Console POC] WebSocket patching complete.");
  }
} catch (err) {
  console.error("[Wha.ts Console POC] Failed to patch WebSocket:", err);
}
