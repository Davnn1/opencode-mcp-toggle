import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpPillIcon, McpToggleContent } from "./client/mcp";

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  provider: string;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  const lifetime = new AbortController();
  const cleanups: (() => void)[] = [];

  const drop = (agentId: string) => {
    pills.get(agentId)?.();
    pills.delete(agentId);
  };

  const register = (agent: AgentLike) => {
    drop(agent.id);
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    if (!String(agent.provider).toLowerCase().includes("opencode")) return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "mcp-toggle",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "MCP Servers",
          label: "MCP",
          icon: McpPillIcon,
          behavior: {
            kind: "popover",
            Content: McpToggleContent,
          },
        },
      }).remove,
    );
  };

  const removeAll = () => {
    for (const remove of pills.values()) {
      try {
        remove();
      } catch {
        /* idempotent best effort */
      }
    }
    pills.clear();
  };

  // Owned subscription: the snapshot seeds pills for already-idle agents (a
  // bare agents.subscribe() only carries future updates), then agent_update
  // messages keep them in sync. Older hosts return no subscription object, so
  // fall back to the plain event stream there.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then((result) => {
      const subscription = (result as { subscription?: { subscribe: (handlers: unknown) => void } })
        .subscription;
      if (subscription) {
        subscription.subscribe({
          snapshot: ({ entries }: { entries: { agent: AgentLike }[] }) => {
            removeAll();
            for (const { agent } of entries) register(agent);
          },
          update: (message: { type?: string; payload?: { kind?: string; agent?: AgentLike; agentId?: string } }) => {
            if (message.type !== "agent_update" || !message.payload) return;
            const update = message.payload;
            if (update.kind === "upsert" && update.agent) register(update.agent);
            else if (update.agentId) drop(update.agentId);
          },
        });
        return;
      }
      removeAll();
      for (const { agent } of result.entries) register(agent);
      const unsubscribe = client.paseo.agents.subscribe((update) => {
        if (update.kind === "upsert") register(update.agent);
        else drop(update.agentId);
      });
      cleanups.push(unsubscribe);
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[mcp-toggle] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    for (const cleanup of cleanups) cleanup();
    removeAll();
  };
}
