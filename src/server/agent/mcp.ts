import "server-only";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Dot } from "@/lib/types";
import * as repo from "../repo";
import { bridgeAuthOk } from "./bridge";
import { runGatedTool } from "./gate";
import { toolsForDot, type ToolDef } from "./tools";

// Tools agy does not have. read_file, write_file, and run_command stay on agy.
const OURS = new Set([
  "open_url",
  "read_page",
  "click",
  "type_text",
  "sign_in",
  "remember",
  "forget",
  "create_routine",
  "delete_routine",
  "send_update",
  "share_file",
  "message_dot",
  "ask_user",
  "app_connect",
]);

export function mcpToolsFor(dot: Dot): ToolDef[] {
  return toolsForDot(dot).filter((t) => OURS.has(t.name) || t.name.startsWith("COMPOSIO_"));
}

function inputSchema(parameters: ToolDef["parameters"]): { type: "object"; [key: string]: unknown } {
  if (parameters && typeof parameters === "object" && (parameters as { type?: string }).type === "object") {
    return parameters as { type: "object"; [key: string]: unknown };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

type Session = { server: Server; transport: WebStandardStreamableHTTPServerTransport };
const g = globalThis as unknown as { __dotsMcp?: Map<string, Session> };
const sessions = () => (g.__dotsMcp ??= new Map());

function serverFor(dotId: string): Server {
  const server = new Server(
    { name: "open-dot", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools for this Open Dot. The browser is the dot's own Chrome (the Computer tab): open_url, read_page, click, type_text, sign_in. " +
        "App tools use the user's Composio account. Memory, routines, share_file, message_dot, and ask_user are here too. " +
        "Do not use these for reading or writing files or for shell commands inside the workspace — those stay with your own tools. " +
        "Anything that sends, pays, or changes something may wait until the user approves it in the chat.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dot = repo.getDot(dotId);
    if (!dot) return { tools: [] };
    return {
      tools: mcpToolsFor(dot).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: inputSchema(t.parameters),
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const dot = repo.getDot(dotId);
    if (!dot) return { content: [{ type: "text", text: "This dot is gone." }], isError: true };
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await runGatedTool(dot, req.params.name, args, extra.signal);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      if (extra.signal.aborted) return { content: [{ type: "text", text: "Not run — the run was stopped." }], isError: true };
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
  return server;
}

/** One streamable-HTTP MCP session per agy process. The token is the one written into this dot's `.agents/`. */
export async function handleMcp(dotId: string, req: Request): Promise<Response> {
  if (!repo.getDot(dotId)) return new Response("Not found", { status: 404 });
  if (!bridgeAuthOk(dotId, req)) return new Response("Unauthorized", { status: 401 });

  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId) {
    const existing = sessions().get(sessionId);
    if (!existing) return new Response("Unknown session", { status: 404 });
    return existing.transport.handleRequest(req);
  }

  const server = serverFor(dotId);
  let transport!: WebStandardStreamableHTTPServerTransport;
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions().set(id, { server, transport });
    },
    onsessionclosed: (id) => {
      const hit = sessions().get(id);
      sessions().delete(id);
      void hit?.server.close().catch(() => {});
    },
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
