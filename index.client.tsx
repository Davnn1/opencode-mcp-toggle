import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpPillIcon, McpToggleContent } from "./client/mcp";

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      pills.get(update.agentId)?.();
      pills.delete(update.agentId);
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId, provider } = update.agent;
    pills.get(agentId)?.();
    if (!provider.toLowerCase().includes("opencode")) return;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "mcp-toggle",
        workspaceId,
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
      }).remove,
    );
  });
  return () => {
    unsubscribe();
    for (const remove of pills.values()) remove();
  };
}
