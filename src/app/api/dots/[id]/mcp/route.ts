import { handleMcp } from "@/server/agent/mcp";

// Streamable HTTP MCP for the agy process of this dot. Config lives in the dot workspace, not in ~/.gemini.
async function handle(req: Request, ctx: RouteContext<"/api/dots/[id]/mcp">) {
  const { id } = await ctx.params;
  return handleMcp(id, req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
