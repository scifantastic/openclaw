/**
 * AgentVox CLI commands.
 *
 *   openclaw agentvox pair [--device-name <name>]
 *   openclaw agentvox status
 *   openclaw agentvox unpair
 */

import type { Command } from "commander";
import type { AgentVoxConfig } from "./config.js";
import { deleteCredentials, hasPairedCredentials, loadCredentials } from "./credentials.js";
import { runPairingFlow } from "./pairing.js";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function registerAgentVoxCli(params: {
  program: Command;
  config: AgentVoxConfig;
  logger: Logger;
  isConnected?: () => boolean;
  uptime?: () => number;
}) {
  const { program, config, logger } = params;

  const cmd = program.command("agentvox").description("AgentVox voice agent integration");

  cmd
    .command("pair")
    .description("Pair with AgentVox app via QR code")
    .option("--device-name <name>", "Device name shown in AgentVox app", config.deviceName)
    .action(async (opts: { deviceName: string }) => {
      if (hasPairedCredentials()) {
        logger.warn("Already paired. Run 'openclaw agentvox unpair' first to re-pair.");
        const creds = loadCredentials();
        if (creds) {
          if (creds.hostId) {
            logger.info(`Current host ID: ${creds.hostId}`);
          } else {
            logger.info(`Current brain ID: ${creds.brainId}`);
          }
        }
        return;
      }

      logger.info("Starting AgentVox pairing...");

      const result = await runPairingFlow({
        hubWsUrl: config.hubUrl,
        deviceName: opts.deviceName,
        logger,
        onCode: ({ formatted, qrPayload, expiresAt }) => {
          // Display pairing info
          console.log("");
          console.log("━".repeat(56));
          console.log("  AgentVox Agent Pairing");
          console.log("━".repeat(56));
          console.log("");
          console.log(`  Device Name: ${opts.deviceName}`);
          console.log(`  Expires:     ${expiresAt}`);
          console.log("");
          console.log("━".repeat(56));
          console.log("  PAIRING CODE:");
          console.log("");
          console.log(`  ${formatted}`);
          console.log("");

          // Try to render QR code in terminal
          try {
            // qrcode-terminal is a runtime dependency
            const qrcode = require("qrcode-terminal");
            qrcode.generate(qrPayload, { small: true }, (qr: string) => {
              for (const line of qr.split("\n")) {
                console.log(`  ${line}`);
              }
            });
          } catch {
            console.log(`  QR payload: ${qrPayload}`);
          }

          console.log("");
          console.log("━".repeat(56));
          console.log("");
          console.log("  Scan with AgentVox app or enter code manually.");
          console.log("  Waiting for confirmation...");
        },
      });

      if (result.ok) {
        console.log("");
        const id = result.credentials.hostId ?? result.credentials.brainId;
        const mode = result.credentials.hostId ? "Host" : "Brain";
        console.log(`  ✓ Paired! ${mode} ID: ${id}`);
        console.log("  Credentials saved.");
        console.log("");
      } else {
        console.error(`  ✗ ${result.error}`);
      }
    });

  cmd
    .command("status")
    .description("Show AgentVox connection status")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds) {
        logger.info("Not paired. Run 'openclaw agentvox pair' to get started.");
        return;
      }

      // Try to query the running gateway for real-time connection state
      let gatewayStatus: {
        connected?: boolean;
        uptime?: number;
        config?: Record<string, unknown>;
      } | null = null;

      try {
        // Use require (jiti-resolved) rather than dynamic import for reliable
        // path resolution from inside the extension directory.
        const { callGatewayCli } = require("../../../src/gateway/call.js") as {
          callGatewayCli: <T>(opts: { method: string; timeoutMs?: number }) => Promise<T>;
        };
        const result = await callGatewayCli<{
          paired?: boolean;
          connected?: boolean;
          uptime?: number;
          config?: Record<string, unknown>;
        }>({ method: "agentvox.status", timeoutMs: 5_000 });
        if (result && typeof result === "object") {
          gatewayStatus = result;
        }
      } catch (err) {
        // Gateway not running, method not available, or import failed
        logger.warn?.(`Gateway query failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const isConnected = gatewayStatus?.connected ?? params.isConnected?.() ?? false;
      const uptime = gatewayStatus?.uptime ?? params.uptime?.() ?? 0;

      console.log("");
      console.log("━".repeat(56));
      console.log("  AgentVox Status");
      console.log("━".repeat(56));
      console.log("");
      if (creds.hostId) {
        console.log(`  Mode:        host`);
        console.log(`  Host ID:     ${creds.hostId}`);
        const agents = gatewayStatus?.agents as
          | Array<{ hostAgentId: string; agentId: string }>
          | undefined;
        if (agents && agents.length > 0) {
          console.log(`  Agents:      ${agents.map((a) => a.hostAgentId).join(", ")}`);
        }
      } else {
        console.log(`  Mode:        agent (legacy)`);
        console.log(`  Brain ID:    ${creds.brainId}`);
      }
      console.log(`  Hub URL:     ${config.hubUrl}`);
      console.log(`  Session:     ${config.sessionKey}`);
      console.log(`  Connected:   ${isConnected ? "yes" : "no"}`);
      if (uptime > 0) {
        console.log(`  Uptime:      ${uptime}s`);
      }
      if (!isConnected && !gatewayStatus) {
        console.log("");
        console.log("  (Could not reach gateway — is it running?)");
      }
      console.log("");
    });

  cmd
    .command("unpair")
    .description("Remove AgentVox pairing credentials")
    .action(() => {
      if (!hasPairedCredentials()) {
        logger.info("Not paired.");
        return;
      }

      deleteCredentials();
      logger.info(
        "AgentVox credentials removed. The gateway service will disconnect on next restart.",
      );
    });
}
