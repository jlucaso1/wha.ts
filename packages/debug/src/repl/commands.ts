import { bytesToHex, bytesToUtf8 } from "@wha.ts/utils/src/bytes-utils";
import type { DebugController } from "../controller";
import type { NetworkEvent } from "../types";

// biome-ignore lint/suspicious/noExplicitAny: For REPL dynamic commands
function formatDataForDisplay(data: any): string {
	if (data instanceof Uint8Array) {
		if (data.length > 128) {
			return `Uint8Array(${data.length} bytes, hex: ${bytesToHex(
				data.slice(0, 32),
			)}...)`;
		}
		// Try to decode as UTF-8 if it looks like text
		try {
			const text = bytesToUtf8(data);
			// Check for non-printable characters (heuristic)
			if (/^[\x20-\x7E\s]*$/.test(text)) {
				return `"${text}" (UTF-8) | hex: ${bytesToHex(data)}`;
			}
		} catch {
			/* ignore if not valid UTF-8 */
		}
		return `Uint8Array(hex: ${bytesToHex(data)})`;
	}
	if (typeof data === "object") {
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return "[Unserializable Object]";
		}
	}
	return String(data);
}

export async function handleREPLCommand(
	controller: DebugController,
	command: string,
	args: string[],
): Promise<string> {
	try {
		switch (command.toLowerCase()) {
			case "help":
				return `Available commands:
  logs network [count=10] [direction=all|send|receive] [layer=all|websocket_raw|frame_raw|noise_payload|xmpp_node] - Show network logs
  logs events [count=10] [name=...] [source=...] - Show client events
  logs errors [count=10] - Show error logs
  state <componentId> - Show latest state of a component (e.g., authenticator, noiseProcessor)
  statehist <componentId> [count=5] - Show state history of a component
  state list - List components with tracked state
  clear <network|events|errors|state|all> [componentId_for_state] - Clear specified logs/state
  ping - Test command
  exit - Exit REPL`;

			case "ping":
				return "pong";

			case "logs": {
				const type = args[0]?.toLowerCase();
				let count = Number.parseInt(args[1] ?? "", 10);
				if (Number.isNaN(count) || count <= 0) count = 10;

				if (type === "network") {
					const directionArg = args[2]?.toLowerCase();
					const layerArg = args[3]?.toLowerCase();
					const filters: {
						direction?: "send" | "receive";
						layer?: NetworkEvent["layer"];
					} = {};
					if (directionArg === "send" || directionArg === "receive")
						filters.direction = directionArg;
					if (
						layerArg &&
						[
							"websocket_raw",
							"frame_raw",
							"noise_payload",
							"xmpp_node",
						].includes(layerArg)
					)
						filters.layer = layerArg as NetworkEvent["layer"];

					const events = controller.getNetworkLog(count, filters);
					if (!events.length) return "No network events found.";
					return events
						.map(
							(e) =>
								`${new Date(e.timestamp).toISOString()} [${e.direction.toUpperCase()}] [${
									e.layer
								}] ${
									e.length !== undefined ? `(${e.length} bytes)` : ""
								} Data: ${formatDataForDisplay(e.data)}${
									e.error ? ` Error: ${e.error}` : ""
								}${e.metadata ? ` Meta: ${JSON.stringify(e.metadata)}` : ""}`,
						)
						.join("\n");
				}
				if (type === "events") {
					const nameFilter = args[2];
					const sourceFilter = args[3];
					const filters: { eventName?: string; sourceComponent?: string } = {};
					if (nameFilter && nameFilter !== "all")
						filters.eventName = nameFilter;
					if (sourceFilter && sourceFilter !== "all")
						filters.sourceComponent = sourceFilter;

					const events = controller.getClientEventLog(count, filters);
					if (!events.length) return "No client events found.";
					return events
						.map(
							(e) =>
								`${new Date(e.timestamp).toISOString()} [${
									e.sourceComponent
								}] ${e.eventName} Payload: ${formatDataForDisplay(e.payload)}`,
						)
						.join("\n");
				}
				if (type === "errors") {
					const errors = controller.getErrorLog(count);
					if (!errors.length) return "No errors found.";
					return errors
						.map(
							(e) =>
								`${new Date(e.timestamp).toISOString()} [${e.source}] ${
									e.message
								}\n  Stack: ${e.stack || "N/A"}\n  Context: ${formatDataForDisplay(
									e.context,
								)}`,
						)
						.join("\n---\n");
				}
				return "Invalid log type. Use: network, events, errors.";
			}

			case "state": {
				const componentId = args[0];
				if (!componentId) return "Usage: state <componentId>";
				if (componentId.toLowerCase() === "list") {
					const components = controller.listMonitoredComponents();
					return components.length
						? `Components with tracked state:\n${components.join("\n")}`
						: "No components with tracked state found.";
				}
				const state = controller.getComponentState(componentId);
				return state
					? `Latest state for [${componentId}] at ${new Date(
							state.timestamp,
						).toISOString()}:\n${formatDataForDisplay(state.state)}`
					: `No state found for component [${componentId}].`;
			}
			case "statehist": {
				const componentId = args[0];
				if (!componentId) return "Usage: statehist <componentId> [count=5]";
				let count = Number.parseInt(args[1] ?? "", 10);
				if (Number.isNaN(count) || count <= 0) count = 5;
				const history = controller.getComponentStateHistory(componentId, count);
				if (!history.length)
					return `No state history found for [${componentId}].`;
				return history
					.map(
						(s) =>
							`State for [${s.componentId}] at ${new Date(
								s.timestamp,
							).toISOString()}:\n${formatDataForDisplay(s.state)}`,
					)
					.join("\n---\n");
			}

			case "clear": {
				const logType = args[0]?.toLowerCase() as
					| "network"
					| "events"
					| "errors"
					| "state"
					| "all"
					| undefined;
				const componentId = args[1];
				if (!logType) return "Usage: clear <network|events|errors|state|all>";
				controller.clearLogs(logType, componentId);
				return `Cleared ${componentId ? `${logType} for ${componentId}` : logType} logs/state.`;
			}

			default:
				return `Unknown command: ${command}. Type 'help' for available commands.`;
		}
	} catch (error: unknown) {
		const err = error instanceof Error ? error : new Error(String(error));
		console.error(`Error executing REPL command '${command}':`, err);
		return `Error: ${err.message}`;
	}
}
