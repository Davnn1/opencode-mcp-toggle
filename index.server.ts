import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { listMcp, setMcp } from "./shared/mcp";
import { listServers, setServer } from "./server/opencode";

interface AgentTarget {
  cwd: string;
  /** Provider session id when the daemon exposes it; used to pick the right
   *  opencode serve instance when several are running. */
  sessionId?: string;
}

/**
 * Resolve an agent's working directory (and session id) daemon-side from its
 * id. The client only ever sends `agentId`; we never trust a client-supplied
 * path. `ref(id).refresh()` fetches the trusted agent record from the daemon —
 * `null` means no such agent.
 */
async function resolveAgent(
  paseo: PluginHandlerContext["paseo"],
  agentId: string,
): Promise<AgentTarget> {
  const result = await paseo.agents.ref(agentId).refresh();
  if (!result) throw new Error("Unknown agent");
  const agent = result.agent as unknown as {
    cwd: string;
    runtimeInfo?: { sessionId?: unknown };
    persistence?: { sessionId?: unknown };
  };
  const sessionId = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId;
  return {
    cwd: agent.cwd,
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : undefined,
  };
}

export default function contribute(server: PluginServerContext) {
  server.handle(listMcp, async ({ agentId }, { paseo }) => {
    const target = await resolveAgent(paseo, agentId);
    return listServers(target.cwd, target.sessionId);
  });
  server.handle(setMcp, async ({ agentId, name, enable, persist, runtime }, { paseo }) => {
    const target = await resolveAgent(paseo, agentId);
    return setServer(target.cwd, name, enable, persist, runtime, target.sessionId);
  });
  return () => {};
}
