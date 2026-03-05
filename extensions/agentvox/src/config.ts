/**
 * AgentVox plugin configuration.
 */

export type AgentVoxConfig = {
  enabled: boolean;
  hubUrl: string;
  sessionKey: string;
  agentId: string;
  deviceName: string;
};

const DEFAULT_HUB_URL = "wss://api.agentvox.bot/ws/brain";
const DEFAULT_SESSION_KEY = "main";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_DEVICE_NAME = "OpenClaw";

export function resolveAgentVoxConfig(raw: Record<string, unknown> | undefined): AgentVoxConfig {
  const r = raw ?? {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    hubUrl: typeof r.hubUrl === "string" && r.hubUrl.trim() ? r.hubUrl.trim() : DEFAULT_HUB_URL,
    sessionKey:
      typeof r.sessionKey === "string" && r.sessionKey.trim()
        ? r.sessionKey.trim()
        : DEFAULT_SESSION_KEY,
    agentId:
      typeof r.agentId === "string" && r.agentId.trim() ? r.agentId.trim() : DEFAULT_AGENT_ID,
    deviceName:
      typeof r.deviceName === "string" && r.deviceName.trim()
        ? r.deviceName.trim()
        : DEFAULT_DEVICE_NAME,
  };
}

/** Derive the HTTP base URL from a WebSocket URL (for pairing API calls). */
export function hubHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/ws\/(brain|agent|host)\/?$/, "");
}

/** Derive the host WebSocket URL from any agent/brain URL. */
export function hubHostUrl(wsUrl: string): string {
  return wsUrl.replace(/\/ws\/(brain|agent)\/?$/, "/ws/host");
}
