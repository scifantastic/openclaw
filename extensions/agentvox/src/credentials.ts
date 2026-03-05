/**
 * Persistent credential storage for AgentVox pairing.
 *
 * Credentials are stored in ~/.openclaw/credentials/agentvox.json (0600).
 * The secrets encryption key is stored separately in agentvox-secrets.key (0600).
 *
 * Credential formats:
 *   Host mode (new):  { hostId, jwtToken }
 *   Agent mode (legacy): { brainId, agentAuthToken }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentVoxCredentials = {
  // Host mode (new, preferred)
  hostId?: string;
  jwtToken?: string; // Host JWT auth token

  // Legacy agent mode (backward compat)
  brainId?: string;
  agentAuthToken?: string;

  // Common
  userId?: string;
};

/** Returns true if these are host credentials (new mode). */
export function isHostCredential(
  creds: AgentVoxCredentials,
): creds is AgentVoxCredentials & { hostId: string; jwtToken: string } {
  return typeof creds.hostId === "string" && typeof creds.jwtToken === "string";
}

/** Returns true if these are legacy agent credentials. */
export function isAgentCredential(
  creds: AgentVoxCredentials,
): creds is AgentVoxCredentials & { brainId: string; agentAuthToken: string } {
  return typeof creds.brainId === "string" && typeof creds.agentAuthToken === "string";
}

function credentialsDir(): string {
  const home = os.homedir();
  return path.join(home, ".openclaw", "credentials");
}

function credentialsPath(): string {
  return path.join(credentialsDir(), "agentvox.json");
}

function secretsKeyPath(): string {
  return path.join(credentialsDir(), "agentvox-secrets.key");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function loadCredentials(): AgentVoxCredentials | null {
  const p = credentialsPath();
  try {
    if (!fs.existsSync(p)) {
      return null;
    }
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);

    // Host credentials
    if (typeof parsed?.hostId === "string" && typeof parsed?.jwtToken === "string") {
      return {
        hostId: parsed.hostId,
        jwtToken: parsed.jwtToken,
        userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      };
    }

    // Legacy agent credentials
    if (typeof parsed?.brainId === "string" && typeof parsed?.agentAuthToken === "string") {
      return {
        brainId: parsed.brainId,
        agentAuthToken: parsed.agentAuthToken,
        userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: AgentVoxCredentials): void {
  const dir = credentialsDir();
  ensureDir(dir);
  const p = credentialsPath();
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600, encoding: "utf-8" });
}

export function saveSecretsKey(key: string): void {
  const dir = credentialsDir();
  ensureDir(dir);
  const p = secretsKeyPath();
  fs.writeFileSync(p, key, { mode: 0o600, encoding: "utf-8" });
}

export function loadSecretsKey(): string | null {
  const p = secretsKeyPath();
  try {
    if (!fs.existsSync(p)) {
      return null;
    }
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}

export function deleteCredentials(): void {
  for (const p of [credentialsPath(), secretsKeyPath()]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch {
      // best-effort
    }
  }
}

export function hasPairedCredentials(): boolean {
  return loadCredentials() !== null;
}
