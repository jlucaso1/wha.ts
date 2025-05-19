import { randomUUID } from "node:crypto";
import express from "express";
import type { DebugController } from "../controller";
import { registerDebugRoutes } from "./routes";

// MCP Imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerMcpHandlers } from "./mcp-handlers";

const DEFAULT_PORT = 7999;
const MCP_STREAMABLE_PATH = "/mcp";
const MCP_SSE_INIT_PATH = "/sse";
const MCP_SSE_MESSAGE_PATH = "/messages";

export interface DebugAPIServerOptions {
	port?: number;
	controller: DebugController;
}

// Store for active transports and their associated McpServer instances
interface ActiveSession {
	server: McpServer;
	transport: StreamableHTTPServerTransport | SSEServerTransport;
	type: "streamable" | "sse";
}
const activeSessions: Record<string, ActiveSession> = {};

// Helper to create and configure a new McpServer instance for a session
function createSessionMcpServer(
	controller: DebugController,
	port: number,
): McpServer {
	const mcpServer = new McpServer({
		name: "wha.ts-debug-mcp-session",
		version: "0.1.0",
		serviceDocumentationUrl: new URL(`http://localhost:${port}/docs/mcp-debug`),
	});
	registerMcpHandlers(mcpServer, controller);
	return mcpServer;
}

export function startDebugAPIServer(options: DebugAPIServerOptions) {
	const app = express();
	const port = options.port ?? DEFAULT_PORT;

	app.use(express.json());
	registerDebugRoutes(app, options.controller);

	// --- Streamable HTTP Endpoint (`/mcp`) ---
	app.all(
		MCP_STREAMABLE_PATH,
		async (req: express.Request, res: express.Response) => {
			const sessionId = req.headers["mcp-session-id"] as string | undefined;
			let session: ActiveSession | undefined = sessionId
				? activeSessions[sessionId]
				: undefined;

			if (session && session.type !== "streamable") {
				res
					.status(400)
					.json({ error: "Session ID type mismatch (expected streamable)" });
				return;
			}

			if (
				req.method === "POST" &&
				!sessionId &&
				isInitializeRequest(req.body)
			) {
				// New Streamable HTTP session initialization
				const newSessionId = randomUUID();
				const mcpServerForSession = createSessionMcpServer(
					options.controller,
					port,
				);
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => newSessionId,
				});

				session = {
					server: mcpServerForSession,
					transport,
					type: "streamable",
				};
				activeSessions[newSessionId] = session;

				transport.onclose = () => {
					console.log(
						`[MCP Streamable] Transport closed for session ${newSessionId}`,
					);
					session?.server.close();
					delete activeSessions[newSessionId];
				};

				res.on("close", () => {
					if (!res.writableEnded) {
						console.log(
							`[MCP Streamable] Client for session ${newSessionId} disconnected prematurely.`,
						);
						transport.close();
					}
				});

				try {
					await mcpServerForSession.connect(transport);
					console.log(
						`[MCP Streamable] New session ${newSessionId} initialized and server connected.`,
					);
				} catch (err) {
					console.error(
						`[MCP Streamable] Error connecting server for session ${newSessionId}:`,
						err,
					);
					delete activeSessions[newSessionId];
					res
						.status(500)
						.json({ error: "Failed to initialize MCP session server" });
					return;
				}
			} else if (!session) {
				const reqId = (req.body as { id?: string | number | null })?.id ?? null;
				res.status(400).json({
					jsonrpc: "2.0",
					id: reqId,
					error: {
						code: -32000,
						message: "Invalid or missing mcp-session-id for Streamable HTTP",
					},
				});
				return;
			}

			// Existing session or newly created one, handle the request
			try {
				await (
					session.transport as StreamableHTTPServerTransport
				).handleRequest(req, res, req.method === "POST" ? req.body : undefined);
			} catch (handleError) {
				console.error(
					`[MCP Streamable] Error in handleRequest for session ${sessionId}:`,
					handleError,
				);
				if (!res.headersSent) {
					res.status(500).json({ error: "Error processing MCP request" });
				}
			}
		},
	);

	// --- Legacy SSE Initialization Endpoint (`/sse`) ---
	app.get(
		MCP_SSE_INIT_PATH,
		async (_req: express.Request, res: express.Response) => {
			console.log(
				"[MCP SSE] Received GET /sse request for legacy client initialization.",
			);
			const mcpServerForSession = createSessionMcpServer(
				options.controller,
				port,
			);
			const transport = new SSEServerTransport(MCP_SSE_MESSAGE_PATH, res);

			const sessionId = transport.sessionId;
			activeSessions[sessionId] = {
				server: mcpServerForSession,
				transport,
				type: "sse",
			};

			console.log(`[MCP SSE] New SSE session ${sessionId} created.`);

			res.on("close", () => {
				console.log(`[MCP SSE] SSE transport closed for session ${sessionId}`);
				mcpServerForSession.close();
				delete activeSessions[sessionId];
			});

			try {
				await mcpServerForSession.connect(transport);
				console.log(
					`[MCP SSE] McpServer connected to SSE transport for session ${sessionId}.`,
				);
			} catch (err) {
				console.error(
					`[MCP SSE] Error connecting McpServer to SSE transport for session ${sessionId}:`,
					err,
				);
				delete activeSessions[sessionId];
				if (!res.headersSent) {
					res.status(500).send("Failed to initialize SSE session server");
				}
			}
		},
	);

	// --- Legacy SSE Message Endpoint (`/messages`) ---
	app.post(
		MCP_SSE_MESSAGE_PATH,
		async (req: express.Request, res: express.Response) => {
			const sessionId = req.query.sessionId as string;
			const session = activeSessions[sessionId];

			if (session && session.type === "sse") {
				try {
					await (session.transport as SSEServerTransport).handlePostMessage(
						req,
						res,
						req.body,
					);
				} catch (err) {
					console.error(
						`[MCP SSE] Error in handlePostMessage for session ${sessionId}:`,
						err,
					);
					if (!res.headersSent) {
						res.status(500).json({ error: "Error processing SSE message" });
					}
				}
			} else {
				console.warn(
					`[MCP SSE] No active SSE session found for ID ${sessionId} or type mismatch.`,
				);
				res
					.status(400)
					.json({
						error: "No active SSE session found for this ID or type mismatch",
					});
			}
		},
	);

	const httpServer = app.listen(port, () => {
		console.log(`[DebugAPI] Server listening on http://localhost:${port}`);
		console.log(
			`[MCP] Streamable HTTP available at http://localhost:${port}${MCP_STREAMABLE_PATH}`,
		);
		console.log(
			`[MCP] Legacy SSE init at GET http://localhost:${port}${MCP_SSE_INIT_PATH}`,
		);
		console.log(
			`[MCP] Legacy SSE messages at POST http://localhost:${port}${MCP_SSE_MESSAGE_PATH}`,
		);
	});

	const shutdown = (signal: string) => {
		console.log(`[DebugAPI] Received ${signal}, shutting down...`);

		// Close all active MCP sessions
		for (const sessionId in activeSessions) {
			const session = activeSessions[sessionId];
			if (session) {
				console.log(
					`[Shutdown] Closing session ${sessionId} (${session.type})`,
				);
				session.transport.close();
				delete activeSessions[sessionId];
			}
		}

		httpServer.close(() => {
			console.log("[DebugAPI] HTTP Server closed.");
			process.exit(0);
		});
		setTimeout(() => {
			console.error("[DebugAPI] Forcefully shutting down after timeout.");
			process.exit(1);
		}, 5000);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return httpServer;
}
