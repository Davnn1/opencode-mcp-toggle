import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { listMcp, setMcp } from "./shared/mcp";
import { listServers, setServer } from "./server/opencode";

/**
 * Resolve an agent's working directory daemon-side from its id. The client only ever
 * sends `agentId`; we never trust a client-supplied path. `ref(id).refresh()` fetches
 * the trusted agent record from the daemon — `null` means no such agent.
 */
async function resolveAgentCwd(
  paseo: PluginHandlerContext["paseo"],
  agentId: string,
): Promise<string> {
  const result = await paseo.agents.ref(agentId).refresh();
  if (!result) throw new Error("Unknown agent");
  return result.agent.cwd;
}

export default function contribute(server: PluginServerContext) {
  server.handle(listMcp, async ({ agentId }, { paseo }) =>
    listServers(await resolveAgentCwd(paseo, agentId)),
  );
  server.handle(setMcp, async ({ agentId, name, enable, persist, runtime }, { paseo }) =>
    setServer(await resolveAgentCwd(paseo, agentId), name, enable, persist, runtime),
  );
  return () => {};
}
