import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { McpPillIcon, McpToggleContent } from "./client/mcp";

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  provider: string;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  const lifetime = new AbortController();

  const register = (agent: AgentLike) => {
    pills.get(agent.id)?.remove();
    pills.delete(agent.id);
    if (stopped || !agent.workspaceId) return;
    if (!agent.provider.toLowerCase().includes("opencode")) return;
    const { id: agentId, workspaceId } = agent;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "mcp-toggle",
        workspaceId: workspaceId as string,
        agentId,
        button: {
          title: "MCP Servers",
          label: "MCP",
          icon: McpPillIcon,
          behavior: {
            kind: "popover",
            Content: McpToggleContent,
          },
        },
      }),
    );
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
