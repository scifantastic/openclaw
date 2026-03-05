/**
 * AgentVox WebSocket client — HOST mode.
 *
 * Connects to /ws/host and manages the persistent connection:
 *   - Authentication with hostId + jwtToken
 *   - Reporting all OpenClaw agents via agents_update
 *   - Tracking backend agentId ↔ host-local agentId mappings
 *   - Ping/pong keepalive
 *   - Reconnection with exponential backoff
 *   - Message routing to handlers (by host-local agentId)
 *
 * Also supports legacy /ws/brain mode when credentials have brainId.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AgentVoxConfig } from "./config.js";
import { hubHostUrl } from "./config.js";
import type { AgentVoxCredentials } from "./credentials.js";
import { isHostCredential } from "./credentials.js";
import type { AgentVoxMessage, HostAgentInfo, AgentMapping } from "./protocol.js";
import { MSG } from "./protocol.js";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type MessageHandler = (msg: AgentVoxMessage) => void | Promise<void>;

export type AgentVoxWsClientOptions = {
  config: AgentVoxConfig;
  credentials: AgentVoxCredentials;
  toolNames: string[];
  logger: Logger;
  onMessage: MessageHandler;
  /** Returns the current list of OpenClaw agents to report to the backend. */
  getAgents: () => HostAgentInfo[];
  /** Called when connection state changes. */
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
  /** Called when agent mappings are received/updated from the backend. */
  onAgentMappings?: (mappings: AgentMapping[]) => void;
};

export type AgentVoxWsClient = {
  connect: () => void;
  disconnect: () => void;
  send: (msg: AgentVoxMessage) => void;
  isConnected: () => boolean;
  uptime: () => number;
  /** Returns current backend agentId ↔ hostAgentId mappings. */
  getAgentMappings: () => AgentMapping[];
};

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const PING_TIMEOUT_MS = 60_000;

function makeMsg(type: string, payload?: Record<string, unknown>): AgentVoxMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    ...(payload ? { payload } : {}),
  };
}

export function createAgentVoxWsClient(opts: AgentVoxWsClientOptions): AgentVoxWsClient {
  const {
    config,
    credentials,
    toolNames,
    logger,
    onMessage,
    onStateChange,
    onAgentMappings,
    getAgents,
  } = opts;

  const hostMode = isHostCredential(credentials);

  let ws: WebSocket | null = null;
  let connected = false;
  let authenticated = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let stopped = false;

  // hostAgentId (OpenClaw agent ID) → backend agentId (UUID)
  let agentMappings: AgentMapping[] = [];

  function resetPingWatchdog() {
    if (pingTimer) {
      clearTimeout(pingTimer);
    }
    pingTimer = setTimeout(() => {
      logger.warn("[agentvox] No ping received for 60s, reconnecting...");
      reconnect();
    }, PING_TIMEOUT_MS);
  }

  function send(msg: AgentVoxMessage) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[agentvox] Cannot send ${msg.type}: not connected`);
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  function sendAuth() {
    if (hostMode && isHostCredential(credentials)) {
      send(
        makeMsg(MSG.AUTH, {
          hostId: credentials.hostId,
          jwtToken: credentials.jwtToken,
          name: config.deviceName || "OpenClaw",
          version: "1.0.0",
        }),
      );
    } else if (credentials.brainId) {
      // Legacy agent mode
      send(
        makeMsg(MSG.AUTH, {
          brainId: credentials.brainId,
          agentId: credentials.brainId,
          agentAuthToken: credentials.agentAuthToken,
        }),
      );
    }
  }

  /** Send the full agent list to the backend. Called after auth_success. */
  function sendAgentsUpdate() {
    const agents = getAgents();
    logger.info(
      `[agentvox] Sending agents_update with ${agents.length} agent(s): ${agents.map((a) => a.agentId).join(", ")}`,
    );
    send(makeMsg(MSG.AGENTS_UPDATE, { agents: agents as unknown as Record<string, unknown>[] }));
  }

  /** Legacy: announce agent as ready (single-agent mode). */
  function sendReady() {
    send(
      makeMsg(MSG.READY, {
        version: "1.0.0",
        apiVersion: "v1",
        capabilities: {
          tools: toolNames,
          maxMessageSize: 10 * 1024 * 1024,
          streaming: true,
        },
        location: "external",
      }),
    );
  }

  function sendPong() {
    send(makeMsg(MSG.PONG, { uptime: Math.floor((Date.now() - startedAt) / 1000) }));
  }

  function handleMessage(raw: string) {
    let msg: AgentVoxMessage;
    try {
      msg = JSON.parse(raw) as AgentVoxMessage;
    } catch {
      logger.warn("[agentvox] Received invalid JSON");
      return;
    }

    // Debug: log if type is undefined
    if (!msg.type) {
      logger.warn("[agentvox] Received message with undefined type, raw:", raw.substring(0, 500));
    }

    switch (msg.type) {
      case MSG.AUTH_SUCCESS: {
        authenticated = true;
        reconnectDelay = MIN_RECONNECT_MS;

        if (hostMode && isHostCredential(credentials)) {
          const payload = msg.payload as
            | { hostId?: string; agentMappings?: AgentMapping[] }
            | undefined;
          logger.info(`[agentvox] Authenticated as host ${credentials.hostId}`);

          // Restore existing mappings from the backend
          if (payload?.agentMappings && payload.agentMappings.length > 0) {
            agentMappings = payload.agentMappings;
            logger.info(`[agentvox] Restored ${agentMappings.length} existing agent mapping(s)`);
            onAgentMappings?.(agentMappings);
          }

          // Report all current agents
          sendAgentsUpdate();
        } else {
          logger.info(`[agentvox] Authenticated as brain ${credentials.brainId}`);
          sendReady();
        }
        break;
      }

      case MSG.AGENTS_UPDATE_ACK: {
        const payload = msg.payload as
          | { agentMappings?: AgentMapping[]; removed?: string[] }
          | undefined;
        if (payload?.agentMappings) {
          agentMappings = payload.agentMappings;
          logger.info(
            `[agentvox] Agent mappings updated: ${agentMappings.length} agent(s) registered`,
          );
          for (const m of agentMappings) {
            logger.info(`[agentvox]   ${m.hostAgentId} → backend ${m.agentId}`);
          }
          onAgentMappings?.(agentMappings);
        }
        break;
      }

      case MSG.PING: {
        resetPingWatchdog();
        sendPong();
        break;
      }

      case MSG.ERROR: {
        const payload = msg.payload as { code?: string; message?: string } | undefined;
        logger.error(`[agentvox] Error: ${payload?.code ?? "UNKNOWN"} - ${payload?.message ?? ""}`);
        if (payload?.code === "INVALID_TOKEN" || payload?.code === "TOKEN_EXPIRED") {
          logger.error("[agentvox] Auth token invalid/expired. Re-pairing may be required.");
          disconnect();
          return;
        }
        break;
      }

      case MSG.DISCONNECT: {
        const payload = msg.payload as { reason?: string; message?: string } | undefined;
        logger.warn(
          `[agentvox] Disconnect: ${payload?.reason ?? "unknown"} - ${payload?.message ?? ""}`,
        );
        if (payload?.reason === "UNAUTHORIZED" || payload?.reason === "PROTOCOL_VIOLATION") {
          disconnect();
          return;
        }
        break;
      }

      default: {
        // Route to handler: message, get_session_context, tool_execute, etc.
        void onMessage(msg);
        break;
      }
    }
  }

  function getWsUrl(): string {
    if (hostMode) {
      return hubHostUrl(config.hubUrl);
    }
    return config.hubUrl;
  }

  function connect() {
    if (stopped) return;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    const url = getWsUrl();
    onStateChange?.("connecting");
    logger.info(`[agentvox] Connecting to ${url}...`);

    ws = new WebSocket(url);
    authenticated = false;

    ws.on("open", () => {
      connected = true;
      startedAt = Date.now();
      onStateChange?.("connected");
      logger.info("[agentvox] WebSocket connected");
      resetPingWatchdog();
      sendAuth();
    });

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      handleMessage(raw);
    });

    ws.on("close", (code, reason) => {
      connected = false;
      authenticated = false;
      onStateChange?.("disconnected");
      if (pingTimer) clearTimeout(pingTimer);
      if (!stopped) {
        logger.warn(
          `[agentvox] WebSocket closed (${code}${reason ? `: ${reason}` : ""}), reconnecting in ${reconnectDelay}ms...`,
        );
        scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      logger.error(`[agentvox] WebSocket error: ${err.message}`);
    });

    ws.on("ping", () => {
      resetPingWatchdog();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      connect();
    }, reconnectDelay);
  }

  function reconnect() {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    ws = null;
    connected = false;
    authenticated = false;
    if (pingTimer) clearTimeout(pingTimer);
    if (!stopped) scheduleReconnect();
  }

  function disconnect() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    connected = false;
    authenticated = false;
    onStateChange?.("disconnected");
  }

  return {
    connect,
    disconnect,
    send,
    isConnected: () => connected && authenticated,
    uptime: () => (startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0),
    getAgentMappings: () => [...agentMappings],
  };
}

/** Helper to build a protocol message with auto-generated id + timestamp. */
export function buildMessage(type: string, payload?: Record<string, unknown>): AgentVoxMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    ...(payload ? { payload } : {}),
  };
}
