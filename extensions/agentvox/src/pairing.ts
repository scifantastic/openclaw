/**
 * AgentVox pairing flow.
 *
 * Implements the HTTP-based pairing dance:
 *   1. POST /api/pairing/init → get pairingId + pairingCode
 *   2. Display QR code + human-readable code
 *   3. Poll GET /api/pairing/status/{pairingId} until confirmed/expired
 *   4. Save credentials
 */

import type { RuntimeLogger } from "openclaw/plugin-sdk";
import { hubHttpUrl } from "./config.js";
import { saveCredentials, saveSecretsKey, type AgentVoxCredentials } from "./credentials.js";
import type { PairingInitResponse, PairingStatusResponse } from "./protocol.js";

export type PairingResult =
  | { ok: true; credentials: AgentVoxCredentials }
  | { ok: false; error: string };

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 200; // ~10 minutes

/** Format a 12-char pairing code as ABCD-EFGH-IJKL */
export function formatPairingCode(code: string): string {
  if (code.length !== 12) {
    return code;
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/** Build the QR code JSON payload. */
export function buildQrPayload(pairingCode: string, wsUrl: string): string {
  return JSON.stringify({ pairing_code: pairingCode, ws_url: wsUrl });
}

/** Run the full pairing flow. Returns credentials on success. */
export async function runPairingFlow(params: {
  hubWsUrl: string;
  deviceName: string;
  logger: RuntimeLogger;
  /** Called when the pairing code is ready for display. */
  onCode?: (opts: {
    pairingCode: string;
    formatted: string;
    qrPayload: string;
    expiresAt: string;
  }) => void;
  /** If provided, used to check for abort. */
  signal?: AbortSignal;
}): Promise<PairingResult> {
  const { hubWsUrl, deviceName, logger, onCode, signal } = params;
  const baseUrl = hubHttpUrl(hubWsUrl);

  // Step 1: Initialize pairing as a HOST (reports multiple agents)
  let initData: PairingInitResponse;
  try {
    const res = await fetch(`${baseUrl}/api/pairing/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName, type: "host" }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Pairing init failed (${res.status}): ${text}` };
    }
    initData = (await res.json()) as PairingInitResponse;
  } catch (err) {
    return {
      ok: false,
      error: `Pairing init request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { pairingId, pairingCode, expiresAt } = initData;
  const formatted = formatPairingCode(pairingCode);
  const qrPayload = buildQrPayload(pairingCode, hubWsUrl);

  logger.info(`AgentVox pairing code: ${formatted} (expires ${expiresAt})`);

  // Step 2: Notify caller so they can display QR/code
  onCode?.({ pairingCode, formatted, qrPayload, expiresAt });

  // Step 3: Poll for confirmation
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { ok: false, error: "Pairing aborted" };
    }

    await sleep(POLL_INTERVAL_MS);

    let status: PairingStatusResponse;
    try {
      const res = await fetch(`${baseUrl}/api/pairing/status/${pairingId}`, { signal });
      if (!res.ok) {
        logger.warn(`Pairing poll failed (${res.status}), retrying...`);
        continue;
      }
      status = (await res.json()) as PairingStatusResponse;
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, error: "Pairing aborted" };
      }
      logger.warn(`Pairing poll error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (status.status === "confirmed") {
      // Host pairing: hostId + agentAuthToken (JWT)
      if (status.hostId && status.agentAuthToken) {
        const creds: AgentVoxCredentials = {
          hostId: status.hostId,
          jwtToken: status.agentAuthToken,
        };
        saveCredentials(creds);
        if (status.secretsEncryptionKey) {
          saveSecretsKey(status.secretsEncryptionKey);
        }
        logger.info(`AgentVox pairing successful! Host ID: ${status.hostId}`);
        return { ok: true, credentials: creds };
      }

      // Legacy agent pairing fallback
      if (status.brainId && status.agentAuthToken) {
        const creds: AgentVoxCredentials = {
          brainId: status.brainId,
          agentAuthToken: status.agentAuthToken,
        };
        saveCredentials(creds);
        if (status.secretsEncryptionKey) {
          saveSecretsKey(status.secretsEncryptionKey);
        }
        logger.info(`AgentVox pairing successful! Brain ID: ${status.brainId}`);
        return { ok: true, credentials: creds };
      }

      return { ok: false, error: "Pairing confirmed but missing credentials in response" };
    }

    if (status.status === "expired") {
      return { ok: false, error: "Pairing code expired. Please try again." };
    }

    // status === "pending" → keep polling
  }

  return { ok: false, error: "Pairing timed out after 10 minutes." };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
