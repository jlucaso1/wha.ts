import { decodeBinaryNode } from "../src/binary/decode";

console.log("[Wha.ts Console POC] Content script injected.");

// --- Utilities (You might eventually import these from wha.ts or a shared util file) ---
function bytesToHex(bytes: string | any[] | Uint8Array<any>, maxLen = 64) {
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

function arrayBufferToUint8Array(buffer: ArrayBuffer) {
  return new Uint8Array(buffer);
}

function arrayBufferToBase64Snippet(buffer: any, maxLength = 64) {
  // ... (same as before) ...
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

// --- Log intercepted data helper (Improved) ---
function logInterceptedData(
  direction: string,
  data: string | ArrayBufferLike | Blob | ArrayBufferView<ArrayBufferLike>
) {
  const timestamp = new Date().toLocaleTimeString();
  const arrow = direction === "send" ? "⬆️ SEND" : "⬇️ RECV";
  let size = 0;
  let dataType = typeof data;
  let frameLength = -1;
  let payloadLength = -1;
  let dataBytes = null; // Hold Uint8Array version

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
        // WhatsApp uses Big Endian for frame length
        frameLength = (view.getUint8(0) << 16) | view.getUint16(1, false);
        payloadLength = size - 3; // Assuming header is always 3 bytes for now

        if (payloadLength !== frameLength && direction === "recv") {
          // Common case for receive: Frame length field describes payload length
          payloadLength = frameLength;
          console.warn(
            `[Wha.ts POC] Frame length mismatch? Header says ${frameLength}, actual payload is ${
              size - 3
            }. Assuming header is correct for payload length.`
          );
          // Note: Send frames might include the 3-byte header in their length? Needs verification.
          // For now, we'll log both based on calculation and header.
        } else if (payloadLength !== frameLength && direction === "send") {
          console.warn(
            `[Wha.ts POC] Frame length mismatch on SEND? Header says ${frameLength}, actual payload is ${
              size - 3
            }.`
          );
          payloadLength = size - 3; // Trust calculated size for send more?
        } else {
          // If they match, simplifies things
          payloadLength = frameLength;
        }
      } else {
        console.warn("[Wha.ts POC] Data too short for framing info.", data);
      }
    } else if (data instanceof Blob) {
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
      // Cannot easily deframe or show hexdump for Blob without reading it first
    } else if (typeof data === "string") {
      size = data.length;
      dataType = "string";
      console.log("%cType: %cstring", "color: black;", "font-weight: bold;");
      console.log(
        "%cContent Snippet:",
        "color: black;",
        data.substring(0, 100) + (data.length > 100 ? "..." : "")
      );
    } else {
      // @ts-ignore
      dataType = data ? Object.prototype.toString.call(data) : "Empty/Null";
      console.log(
        "%cType: %c%s",
        "color: black;",
        "font-weight: bold;",
        dataType
      );
    }

    // Log Details
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
      console.log(
        `%cCalculated Payload Length:%c ${size - 3}`,
        "color: black;",
        "font-weight: normal;"
      );
    }

    // Log Hexdump and Base64 Snippets (only if we have bytes)
    if (dataBytes) {
      console.log(
        "%cBase64 Snippet:%c %s",
        "color: black;",
        "font-family: monospace;",
        arrayBufferToBase64Snippet(dataBytes.buffer)
      );
      console.log(
        "%cHexdump Snippet:%c %s",
        "color: black;",
        "font-family: monospace;",
        bytesToHex(dataBytes)
      );
      if (payloadLength >= 0 && size >= 3) {
        const payloadBytes = dataBytes.slice(3); // Get the payload part
        console.log(
          "%cPayload Hexdump Snippet:%c %s",
          "color: black;",
          "font-family: monospace;",
          bytesToHex(payloadBytes)
        );
      }
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
  // @ts-ignore
  if (typeof decodeBinaryNode !== "function") {
    console.error(
      "ERROR: `decodeBinaryNode` function is not available. Build/bundle wha.ts first."
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

// --- Patch WebSocket (remains largely the same, calls the improved logger) ---
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
      logInterceptedData("send", data); // Use improved logger
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
          logInterceptedData("receive", event ? event.data : "[No event data]"); // Use improved logger
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

    // --- Patch 'onmessage' setter (remains largely the same, calls improved logger) ---
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
            this._whaTsOriginalOnMessage = listener;
            const wrappedListener = (event: { data: any }) => {
              logInterceptedData(
                "receive",
                event ? event.data : "[No event data]"
              ); // Use improved logger
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
            this._whaTsWrappedOnMessageGetterValue = wrappedListener;
            Reflect.apply(originalOnMessageSetter, this, [wrappedListener]);
          } else {
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
