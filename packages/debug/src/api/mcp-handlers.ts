import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bytesToBase64 } from "../../../utils/src/bytes-utils";
import type { DebugController } from "../controller";
import type { NetworkEvent } from "../types";
import { sanitizeObjectForJSON } from "./sanitize";

// Helper to make network event data JSON serializable
const sanitizeNetworkEventForJSON = (event: NetworkEvent): NetworkEvent => {
	const sanitizedEvent = { ...event };
	if (event.data instanceof Uint8Array) {
		sanitizedEvent.data = bytesToBase64(event.data);
	}
	return sanitizedEvent;
};

export function registerMcpHandlers(
	mcpServer: McpServer,
	controller: DebugController,
) {
	const MCP_PREFIX = "mcp://wha.ts-debug";

	// --- Resources ---

	mcpServer.resource(
		"logs-network",
		`${MCP_PREFIX}/logs/network`,
		{
			description:
				"Get network logs. Params: count (int), direction (send|receive), layer (websocket_raw|frame_raw|noise_payload|xmpp_node)",
		},
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = countParam ? Number.parseInt(countParam, 10) : undefined;
			const direction = uri.searchParams.get("direction") as
				| "send"
				| "receive"
				| undefined;
			const layer = uri.searchParams.get("layer") as
				| NetworkEvent["layer"]
				| undefined;

			const filters: {
				direction?: "send" | "receive";
				layer?: NetworkEvent["layer"];
			} = {};
			if (direction) filters.direction = direction;
			if (layer) filters.layer = layer;

			const events = controller
				.getNetworkLog(count, filters)
				.map(sanitizeNetworkEventForJSON);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(events),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"logs-events",
		`${MCP_PREFIX}/logs/events`,
		{
			description:
				"Get client event logs. Params: count (int), name (string), source (string)",
		},
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = countParam ? Number.parseInt(countParam, 10) : undefined;
			const eventName = uri.searchParams.get("name") || undefined;
			const sourceComponent = uri.searchParams.get("source") || undefined;

			const filters: { eventName?: string; sourceComponent?: string } = {};
			if (eventName) filters.eventName = eventName;
			if (sourceComponent) filters.sourceComponent = sourceComponent;

			const events = controller.getClientEventLog(count, filters);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(events),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"logs-errors",
		`${MCP_PREFIX}/logs/errors`,
		{ description: "Get error logs. Params: count (int)" },
		async (uri: URL) => {
			const countParam = uri.searchParams.get("count");
			const count = countParam ? Number.parseInt(countParam, 10) : undefined;
			const errors = controller.getErrorLog(count);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(errors),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"state-list",
		`${MCP_PREFIX}/state/list`,
		{ description: "List all components with tracked state." },
		async (uri: URL) => {
			const components = controller.listMonitoredComponents();
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(components),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"component-state",
		new ResourceTemplate(`${MCP_PREFIX}/state/{componentId}`, {
			list: undefined,
		}),
		{
			description:
				"Get the latest state of a specific component. Path param: componentId (string)",
		},
		async (uri: URL, variables) => {
			let componentId = variables.componentId;
			if (Array.isArray(componentId)) componentId = componentId[0];
			if (typeof componentId !== "string" || !componentId) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({ error: "Invalid or missing componentId" }),
							mimeType: "application/json",
						},
					],
				};
			}
			const snapshot = controller.getComponentState(componentId);
			let textContent: string;
			if (snapshot) {
				const sanitizedSnapshot = {
					...snapshot,
					state: sanitizeObjectForJSON(snapshot.state),
				};
				textContent = JSON.stringify(sanitizedSnapshot);
			} else {
				textContent = JSON.stringify({ error: "Component state not found" });
			}
			return {
				contents: [
					{
						uri: uri.href,
						text: textContent,
						mimeType: "application/json",
					},
				],
			};
		},
	);

	mcpServer.resource(
		"component-state-history",
		new ResourceTemplate(`${MCP_PREFIX}/statehist/{componentId}`, {
			list: undefined,
		}),
		{
			description:
				"Get state history of a component. Path param: componentId (string). Query param: count (int)",
		},
		async (uri: URL, variables) => {
			let componentId = variables.componentId;
			if (Array.isArray(componentId)) componentId = componentId[0];
			if (typeof componentId !== "string" || !componentId) {
				return {
					contents: [
						{
							uri: uri.href,
							text: JSON.stringify({ error: "Invalid or missing componentId" }),
							mimeType: "application/json",
						},
					],
				};
			}
			const countParam = uri.searchParams.get("count");
			const count = countParam ? Number.parseInt(countParam, 10) : undefined;
			const history = controller.getComponentStateHistory(componentId, count);
			let textContent: string;
			if (history.length > 0) {
				const sanitizedHistory = history.map((s) => ({
					...s,
					state: sanitizeObjectForJSON(s.state),
				}));
				textContent = JSON.stringify(sanitizedHistory);
			} else {
				textContent = JSON.stringify({
					error: "Component state history not found",
				});
			}
			return {
				contents: [
					{
						uri: uri.href,
						text: textContent,
						mimeType: "application/json",
					},
				],
			};
		},
	);

	// --- Tools ---

	mcpServer.tool(
		"clear-logs",
		{
			type: z.enum(["network", "events", "errors", "state", "all"]),
			componentId: z
				.string()
				.optional()
				.describe(
					"Component ID, required if type is 'state' and clearing for a specific component.",
				),
		},
		async (args: {
			type: "network" | "events" | "errors" | "state" | "all";
			componentId?: string;
		}) => {
			if (args.type === "state" && !args.componentId) {
				// Ask to clear all component states
			} else if (args.type !== "state" && args.componentId) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "componentId is only applicable when type is 'state'.",
						},
					],
				};
			}
			controller.clearLogs(args.type, args.componentId);
			return {
				content: [
					{
						type: "text",
						text: `Cleared ${args.componentId ? `${args.type} for ${args.componentId}` : args.type} logs/state.`,
					},
				],
			};
		},
	);

	// --- Signal protocol state resources ---

	// List all signal session component IDs
	mcpServer.resource(
		"signal-sessions-list",
		`${MCP_PREFIX}/state/signal/sessions`,
		{
			description:
				"Lists all protocol addresses with tracked Signal session state. The address can be used with /state/signal:session:{address} to get details.",
		},
		async (uri: URL) => {
			const allComponents = controller.listMonitoredComponents();
			const signalSessionComponentIds = allComponents.filter((id) =>
				id.startsWith("signal:session:"),
			);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify(signalSessionComponentIds),
						mimeType: "application/json",
					},
				],
			};
		},
	);

	// Get the client's own Signal identity state
	mcpServer.resource(
		"signal-identity-state",
		`${MCP_PREFIX}/state/signal/identity`,
		{
			description:
				"Get the client's own Signal identity keys and registration ID.",
		},
		async (uri: URL) => {
			const componentId = "signal:identity";
			const snapshot = controller.getComponentState(componentId);
			let textContent: string;

			if (snapshot) {
				const sanitizedSnapshot = {
					...snapshot,
					state: sanitizeObjectForJSON(snapshot.state),
				};
				textContent = JSON.stringify(sanitizedSnapshot);
			} else {
				textContent = JSON.stringify({
					error: `State for '${componentId}' not found`,
				});
			}
			return {
				contents: [
					{
						uri: uri.href,
						text: textContent,
						mimeType: "application/json",
					},
				],
			};
		},
	);

	console.log("[MCP Debug Server] MCP Handlers registered.");
}
