import { bridgeAuthOk } from "@/server/agent/bridge";
import { decideAgyHook, type HookDecision } from "@/server/agent/gate";
import * as repo from "@/server/repo";

// agy's PreToolUse hook posts here and waits. The response is the JSON it prints on stdout.
export async function POST(req: Request, ctx: RouteContext<"/api/dots/[id]/hook">) {
  const { id } = await ctx.params;
  const dot = repo.getDot(id);
  if (!dot) return Response.json({ decision: "deny", reason: "This dot is gone." } satisfies HookDecision);
  if (!bridgeAuthOk(id, req)) return Response.json({ decision: "deny", reason: "Open Dot rejected this hook." } satisfies HookDecision, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ decision: "deny", reason: "The hook payload was not JSON." } satisfies HookDecision);
  }
  const call = (body as { toolCall?: { name?: string; args?: Record<string, unknown> } } | null)?.toolCall;
  const name = typeof call?.name === "string" ? call.name : "";
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  const decision = await decideAgyHook(dot, name, args, req.signal);
  return Response.json(decision);
}
