import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bytesToBase64 } from "../../../utils/src/bytes-utils";
import type { DebugController } from "../controller";
import type { NetworkEvent } from "../types";

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
			const state = controller.getComponentState(componentId);
			return {
				contents: [
					{
						uri: uri.href,
						text: state
							? JSON.stringify(state)
							: JSON.stringify({ error: "Component state not found" }),
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
			return {
				contents: [
					{
						uri: uri.href,
						text:
							history.length > 0
								? JSON.stringify(history)
								: JSON.stringify({
										error: "Component state history not found",
									}),
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

	console.log("[MCP Debug Server] MCP Handlers registered.");
}
