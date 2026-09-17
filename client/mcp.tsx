import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { listMcp, setMcp, type McpServer } from "../shared/mcp";

const POLL_MS = 5000;

function agentIdOf(props: { context: string; agentId?: string }): string | undefined {
  return props.context === "agent" ? props.agentId : undefined;
}

function useServerList(agentId: string | undefined) {
  const rpcList = useRpc(listMcp);
  return useQuery({
    queryKey: ["opencode-mcp-toggle", "list", agentId ?? ""],
    queryFn: () => rpcList({ agentId: agentId ?? "" }),
    enabled: Boolean(agentId),
    refetchInterval: POLL_MS,
  });
}

function statusColor(
  status: string,
  theme: {
    statusSuccess: string;
    statusWarning: string;
    statusDanger: string;
    foregroundMuted: string;
  },
): string {
  switch (status) {
    case "connected":
      return theme.statusSuccess;
    case "connecting":
    case "reconnecting":
      return theme.statusWarning;
    case "failed":
    case "error":
      return theme.statusDanger;
    default:
      return theme.foregroundMuted;
  }
}

function ToggleSwitch({
  value,
  disabled,
  onChange,
  activeColor,
  trackOffColor,
  knobColor,
}: {
  value: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  activeColor: string;
  trackOffColor: string;
  knobColor: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? "Disable MCP server" : "Enable MCP server"}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        backgroundColor: value ? activeColor : trackOffColor,
        justifyContent: "center",
        paddingHorizontal: 2,
        alignItems: value ? "flex-end" : "flex-start",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: knobColor,
        }}
      />
    </Pressable>
  );
}

function ServerRow({
  server,
  agentId,
  saveToConfig,
  theme,
  onToggled,
}: {
  server: McpServer;
  agentId: string | undefined;
  saveToConfig: boolean;
  theme: {
    foreground: string;
    foregroundMuted: string;
    surface1: string;
    surface2: string;
    border: string;
    accent: string;
    statusSuccess: string;
    statusWarning: string;
    statusDanger: string;
  };
  onToggled: () => void;
}) {
  const rpcSet = useRpc(setMcp);
  const mutation = useMutation({
    mutationFn: (input: { enable: boolean; persist: boolean; runtime: boolean }) =>
      rpcSet({ agentId: agentId ?? "", name: server.name, ...input }),
    onSuccess: onToggled,
  });
  const runtimeOn = server.status === "connected" || server.status === "connecting";
  const isSessionOverride =
    server.configEnabled !== null && runtimeOn !== server.configEnabled;

  return (
    <View style={{ gap: 2 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: 10,
          paddingHorizontal: 12,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9, flex: 1 }}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: statusColor(server.status, theme),
            }}
          />
          <Text
            style={{
              color: runtimeOn ? theme.foreground : theme.foregroundMuted,
              fontSize: 13,
              fontWeight: runtimeOn ? "600" : "400",
              fontFamily: Platform.select({
                ios: "Menlo",
                android: "monospace",
                default: "monospace",
              }),
            }}
            numberOfLines={1}
          >
            {server.name}
          </Text>

          {isSessionOverride ? (
            <View
              style={{
                backgroundColor: theme.surface2,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 4,
              }}
            >
              <Text style={{ color: theme.foregroundMuted, fontSize: 10 }}>
                session only
              </Text>
            </View>
          ) : null}

          {server.status === "connecting" ||
          server.status === "failed" ||
          server.status === "error" ? (
            <Text style={{ color: statusColor(server.status, theme), fontSize: 10 }}>
              {server.status}
            </Text>
          ) : null}
        </View>

        <ToggleSwitch
          value={runtimeOn}
          disabled={mutation.isPending}
          onChange={(next) =>
            mutation.mutate({ enable: next, persist: saveToConfig, runtime: true })
          }
          activeColor={theme.accent}
          trackOffColor={theme.surface2}
          knobColor={theme.foreground}
        />
      </View>

      {mutation.isError ? (
        <Text
          style={{ color: theme.statusDanger, fontSize: 11, paddingHorizontal: 12, paddingBottom: 4 }}
          numberOfLines={1}
        >
          {mutation.error instanceof Error ? mutation.error.message : "Action failed"}
        </Text>
      ) : null}
    </View>
  );
}

export function McpToggleContent(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = agentIdOf(props);
  const [saveToConfig, setSaveToConfig] = useState(true);
  const queryClient = useQueryClient();
  const list = useServerList(agentId);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["opencode-mcp-toggle", "list"] });

  const servers = list.data?.servers ?? [];
  const connected = servers.filter(
    (server) => server.status === "connected" || server.status === "connecting",
  ).length;

  return (
    <View
      style={{
        width: layout.compact ? undefined : 320,
        alignSelf: layout.compact ? "stretch" : undefined,
        gap: 10,
      }}
    >
      {/* Header bar */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 2,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            MCP Servers
          </Text>
          <View
            style={{
              backgroundColor:
                connected > 0 ? theme.colors.accent + "22" : theme.colors.surface2,
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 10,
            }}
          >
            <Text
              style={{
                color: connected > 0 ? theme.colors.accent : theme.colors.foregroundMuted,
                fontSize: 11,
                fontVariant: ["tabular-nums"],
              }}
            >
              {`${connected}/${servers.length}`}
            </Text>
          </View>
        </View>

        {/* Global Save as default checkbox */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle save as default"
          onPress={() => setSaveToConfig(!saveToConfig)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingVertical: 2,
            paddingHorizontal: 4,
          }}
        >
          <View
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              borderWidth: 1.5,
              borderColor: saveToConfig ? theme.colors.accent : theme.colors.foregroundMuted,
              backgroundColor: saveToConfig ? theme.colors.accent : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {saveToConfig ? (
              <Icon name="Check" size={10} color={theme.colors.accentForeground} />
            ) : null}
          </View>
          <Text
            style={{
              color: saveToConfig ? theme.colors.foreground : theme.colors.foregroundMuted,
              fontSize: 11,
            }}
          >
            Save as default
          </Text>
        </Pressable>
      </View>

      {/* Content list or friendly states */}
      {list.isLoading ? (
        <View style={{ paddingVertical: 16, alignItems: "center" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Loading MCP servers…
          </Text>
        </View>
      ) : list.isError ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
            {list.error instanceof Error ? list.error.message : "Failed to load MCP servers"}
          </Text>
        </View>
      ) : servers.length === 0 ? (
        <View
          style={{
            padding: 16,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            alignItems: "center",
            gap: 4,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>
            {list.data?.port === null
              ? "OpenCode server not running"
              : "No MCP servers configured"}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            {list.data?.port === null
              ? "Start or interact with an OpenCode agent to manage MCP tools."
              : "Add MCP server entries to your opencode.json."}
          </Text>
        </View>
      ) : (
        <View
          style={{
            borderRadius: 10,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            overflow: "hidden",
          }}
        >
          {servers.map((server, index) => (
            <View key={server.name}>
              {index > 0 ? (
                <View
                  style={{
                    height: 1,
                    backgroundColor: theme.colors.border,
                    opacity: 0.5,
                  }}
                />
              ) : null}
              <ServerRow
                server={server}
                agentId={agentId}
                saveToConfig={saveToConfig}
                theme={theme.colors}
                onToggled={invalidate}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function McpPillIcon(props: PluginButtonIconProps) {
  const { theme } = props;
  const agentId = agentIdOf(props);
  const list = useServerList(agentId);

  const servers = list.data?.servers ?? [];
  const connected = servers.some(
    (server) => server.status === "connected" || server.status === "connecting",
  );

  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: connected ? theme.colors.accent : theme.colors.foregroundMuted,
      }}
    />
  );
}
