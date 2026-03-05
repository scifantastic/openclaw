/**
 * AgentVox plugin for OpenClaw.
 *
 * Allows an openclaw instance to act as a third-party AgentVox agent,
 * so users can talk to their openclaw instance via the AgentVox iOS app.
 *
 * Two modes:
 *   - Agent mode: AgentVox sends `message`, openclaw runs its agent pipeline → `response`
 *   - V2V mode: AgentVox runs its own voice model, uses `message.append` to write all
 *     message types directly, and `get_session_context` to read context.
 *
 * Both modes share tool execution (`tool_execute`) and session sync (`session_sync`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAgentVoxCli } from "./src/cli.js";
import { resolveAgentVoxConfig, type AgentVoxConfig } from "./src/config.js";
import { loadCredentials, isHostCredential } from "./src/credentials.js";
import { createMessageHandler } from "./src/handlers.js";
import { setActiveCanvasPort } from "./src/handlers.js";
import type { HostAgentInfo, AgentMapping } from "./src/protocol.js";
import { MSG } from "./src/protocol.js";
import { createStreamingBridge, type StreamingBridge } from "./src/streaming-bridge.js";
import { createAgentVoxWsClient, type AgentVoxWsClient } from "./src/ws-client.js";
import { buildMessage } from "./src/ws-client.js";

// Module-level shared state so the before_tool_call hook (bound at register time)
// can access the WS client (set at service start time). Needed because the plugin
// system may call register() in a different scope than where the service runs.
let _sharedClient: AgentVoxWsClient | null = null;
let _sharedConfig: AgentVoxConfig | null = null;

const agentVoxPlugin = {
  id: "agentvox",
  name: "AgentVox",
  description: "AgentVox voice agent integration — act as a third-party AgentVox agent",
  configSchema: {
    parse(value: unknown): Record<string, unknown> {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return raw;
    },
    uiHints: {
      enabled: { label: "Enabled" },
      hubUrl: {
        label: "Hub URL",
        help: "AgentVox hub WebSocket URL.",
        advanced: true,
      },
      sessionKey: {
        label: "Session Key",
        help: "OpenClaw session key to bridge (default: main).",
      },
      agentId: {
        label: "Agent ID",
        help: "OpenClaw agent ID to use (default: main).",
      },
      deviceName: {
        label: "Device Name",
        help: "Name shown in AgentVox iOS app.",
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const config = resolveAgentVoxConfig(api.pluginConfig as Record<string, unknown> | undefined);

    // If no explicit deviceName was configured, use the machine hostname so the
    // user can tell which machine paired in the AgentVox Connections settings.
    const rawDeviceName =
      api.pluginConfig &&
      typeof api.pluginConfig === "object" &&
      typeof (api.pluginConfig as Record<string, unknown>).deviceName === "string" &&
      (api.pluginConfig as Record<string, unknown>).deviceName;
    if (!rawDeviceName) {
      (config as { deviceName: string }).deviceName = os.hostname();
    }

    let client: AgentVoxWsClient | null = null;
    let streamingBridge: StreamingBridge | null = null;
    let connectionState: "disconnected" | "connecting" | "connected" = "disconnected";
    let currentAgentMappings: AgentMapping[] = [];

    // Collect tool names from the plugin registry
    function getToolNames(): string[] {
      try {
        // Access tool names from the registry at runtime
        const { requireActivePluginRegistry } = require("../../src/plugins/runtime.js");
        const registry = requireActivePluginRegistry();
        // Each entry has a `names` array (e.g. ["exec", "Read", "Write", ...])
        return registry.tools
          .flatMap((t: { names?: string[] }) => t.names ?? [])
          .filter(Boolean) as string[];
      } catch {
        return [];
      }
    }

    /**
     * Read an agent's emoji from its IDENTITY.md file.
     * Looks for a line matching "Emoji: <value>" (case-insensitive).
     */
    function readAgentEmoji(workspacePath: string): string | undefined {
      try {
        const identityPath = path.join(workspacePath, "IDENTITY.md");
        if (!fs.existsSync(identityPath)) return undefined;
        const content = fs.readFileSync(identityPath, "utf-8");
        // Match lines like: "- **Emoji:** 🎙️" or "- Emoji: 🎙️" or "Emoji: 🎙️"
        const match = content.match(/^\s*[-*]?\s*\*{0,2}Emoji\*{0,2}:?\*{0,2}\s*(.+)$/im);
        return match?.[1]?.trim() || undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Return the list of OpenClaw agents to report to the AgentVox backend.
     * Reads from openclaw.json config. Falls back to just "main" if config is unreadable.
     * Also reads each agent's emoji from their IDENTITY.md.
     */
    function getAgents(): HostAgentInfo[] {
      try {
        const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const list: Array<{ id: string; name?: string; workspace?: string }> =
          raw?.agents?.list ?? [];
        if (list.length === 0) {
          return [{ agentId: "main", name: "main", status: "ready" }];
        }
        return list.map((a) => {
          const emoji = a.workspace ? readAgentEmoji(a.workspace) : undefined;
          return {
            agentId: a.id,
            name: a.name || a.id,
            emoji,
            version: "1.0.0",
            status: "ready" as const,
          };
        });
      } catch {
        return [{ agentId: "main", name: "main", status: "ready" }];
      }
    }

    // --- Gateway methods for web UI / mobile app control ---

    api.registerGatewayMethod("agentvox.status", ({ respond }: GatewayRequestHandlerOptions) => {
      const creds = loadCredentials();
      const hostCreds = creds && isHostCredential(creds);
      respond(true, {
        paired: !!creds,
        mode: hostCreds ? "host" : "agent",
        hostId: creds?.hostId ?? null,
        brainId: creds?.brainId ?? null,
        connected: connectionState === "connected",
        uptime: client?.uptime() ?? 0,
        agents: currentAgentMappings.map((m) => ({
          hostAgentId: m.hostAgentId,
          agentId: m.agentId,
        })),
        config: {
          enabled: config.enabled,
          hubUrl: config.hubUrl,
          sessionKey: config.sessionKey,
          agentId: config.agentId,
          deviceName: config.deviceName,
        },
      });
    });

    api.registerGatewayMethod("agentvox.unpair", ({ respond }: GatewayRequestHandlerOptions) => {
      const { deleteCredentials } = require("./src/credentials.js");
      deleteCredentials();
      if (client) {
        client.disconnect();
        client = null;
      }
      connectionState = "disconnected";
      respond(true, { ok: true });
    });

    // --- Canvas tool hook: intercept canvas calls and route to AgentVox app ---
    // Lazy-loaded to avoid crashing plugin registration if require() fails
    let _buildMessage: any = null;
    let _MSG: any = null;
    let _setPort: any = null;

    api.on("before_tool_call", (event: any) => {
      try {
        if (event?.toolName !== "canvas") {
          return {};
        }

        if (!_sharedClient?.isConnected()) {
          api.logger.info(
            `[agentvox] Canvas hook: sharedClient=${!!_sharedClient}, passing through`,
          );
          return {};
        }

        // Lazy import
        if (!_buildMessage) {
          try {
            _buildMessage = require("./src/ws-client.js").buildMessage;
            _MSG = require("./src/protocol.js").MSG;
            _setPort = require("./src/handlers.js").setActiveCanvasPort;
          } catch (importErr) {
            api.logger.error(`[agentvox] Canvas hook import error: ${importErr}`);
            return {};
          }
        }

        const params = event.params || {};
        const action = params.action;
        if (!action) return {};

        const url = params.url || params.target;

        let port: number | undefined;
        if (url) {
          try {
            const parsed = new URL(url);
            if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
              port = parseInt(parsed.port) || 80;
              _setPort(port);
            }
          } catch {
            // Not a URL
          }
        }

        // Use the host-local agentId from config — the backend resolves it
        // to the correct backend agentId via host→agent mappings.
        const agentId = _sharedConfig?.agentId || "main";

        _sharedClient.send(
          _buildMessage(_MSG.CANVAS_EVENT, {
            agentId,
            sessionId: "main",
            action,
            url: url || undefined,
            port: port || undefined,
          }),
        );

        api.logger.info(
          `[agentvox] Canvas ${action} routed to AgentVox app${url ? ` (url: ${url})` : ""}${port ? ` (port: ${port})` : ""}`,
        );

        if (action === "snapshot" || action === "eval") {
          return {};
        }

        return {
          block: true,
          blockReason: `OK: Canvas ${action} sent to AgentVox app successfully.${url ? ` URL: ${url}` : ""}`,
        };
      } catch (err) {
        api.logger.error(`[agentvox] Canvas hook error: ${err}`);
        return {};
      }
    });

    // --- CLI commands ---

    api.registerCli(
      ({ program }) =>
        registerAgentVoxCli({
          program,
          config,
          logger: api.logger,
          isConnected: () => client?.isConnected() ?? false,
          uptime: () => client?.uptime() ?? 0,
        }),
      { commands: ["agentvox"] },
    );

    // --- Service: manages the WebSocket connection lifecycle ---

    api.registerService({
      id: "agentvox",
      start: async () => {
        if (!config.enabled) {
          api.logger.info("[agentvox] Plugin disabled, skipping.");
          return;
        }

        // Guard against double-start: clean up any existing connection first
        if (client) {
          api.logger.info("[agentvox] Cleaning up previous connection before reconnecting.");
          if (streamingBridge) {
            streamingBridge.stop();
            streamingBridge = null;
          }
          client.disconnect();
          client = null;
        }

        const creds = loadCredentials();
        if (!creds) {
          api.logger.info("[agentvox] Not paired. Run 'openclaw agentvox pair' to connect.");
          return;
        }

        const toolNames = getToolNames();

        // Use a late-binding proxy so the handler always dispatches to the
        // current `client` reference, avoiding the chicken-and-egg problem.
        const clientProxy: AgentVoxWsClient = {
          connect: () => client?.connect(),
          disconnect: () => client?.disconnect(),
          send: (msg) => client?.send(msg),
          isConnected: () => client?.isConnected() ?? false,
          uptime: () => client?.uptime() ?? 0,
          getAgentMappings: () => client?.getAgentMappings() ?? [],
        };

        const handler = createMessageHandler({
          config,
          client: clientProxy,
          logger: api.logger,
          runtime: api.runtime,
          getToolNames,
        });

        client = createAgentVoxWsClient({
          config,
          credentials: creds,
          toolNames,
          logger: api.logger,
          onMessage: handler,
          getAgents,
          onAgentMappings: (mappings) => {
            currentAgentMappings = mappings;
          },
          onStateChange: (state) => {
            connectionState = state;
            // Start/stop streaming bridge based on connection state
            if (state === "connected" && !streamingBridge) {
              // Detect event hooks availability (requires PR #16044)
              const runtimeEvents = api.runtime.events as Record<string, unknown> | undefined;
              const bridgeEvents = {
                onAgentEvent:
                  runtimeEvents && typeof runtimeEvents.onAgentEvent === "function"
                    ? (runtimeEvents.onAgentEvent as any)
                    : undefined,
                onSessionTranscriptUpdate:
                  runtimeEvents && typeof runtimeEvents.onSessionTranscriptUpdate === "function"
                    ? (runtimeEvents.onSessionTranscriptUpdate as any)
                    : undefined,
              };
              streamingBridge = createStreamingBridge({
                config,
                client: clientProxy,
                logger: api.logger,
                events: bridgeEvents,
              });
              streamingBridge.start();
            } else if (state === "disconnected" && streamingBridge) {
              streamingBridge.stop();
              streamingBridge = null;
            }
          },
        });

        client.connect();
        _sharedClient = client;
        _sharedConfig = config;
        api.logger.info("[agentvox] Service started, connecting to hub...");
      },
      stop: async () => {
        if (streamingBridge) {
          streamingBridge.stop();
          streamingBridge = null;
        }
        if (client) {
          client.disconnect();
          client = null;
        }
        connectionState = "disconnected";
        _sharedClient = null;
        api.logger.info("[agentvox] Service stopped.");
      },
    });
  },
};

export default agentVoxPlugin;
