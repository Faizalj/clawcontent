/**
 * OpenClaw agent integration
 * Primary: Gateway HTTP API (/v1/chat/completions) — session-aware
 * Fallback: CLI (openclaw agent --message) — if HTTP API not enabled
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  model: string;
  workspace: string;
}

export interface AgentResponse {
  success: boolean;
  message: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

interface GatewayConfig {
  port: number;
  token: string;
}

let _gwCache: GatewayConfig | null = null;

function getGatewayConfig(): GatewayConfig | null {
  if (_gwCache) return _gwCache;

  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    _gwCache = {
      port: config?.gateway?.port || 18789,
      token: config?.gateway?.auth?.token || config?.gateway?.auth?.password || "",
    };
    return _gwCache;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent list
// ---------------------------------------------------------------------------

export function getAgentList(): AgentInfo[] {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    const agentList = config?.agents?.list || [];
    return agentList.map((a: any) => {
      let emoji = "";
      let displayName = a.name || a.id;
      const identityPath = join(
        homedir(), ".openclaw", "agents", a.id, "agent", "IDENTITY.md"
      );
      try {
        const identity = readFileSync(identityPath, "utf-8");
        const emojiMatch = identity.match(
          /^#+\s*([\p{Emoji_Presentation}\p{Emoji}\u200d]+)/mu
        );
        if (emojiMatch) emoji = emojiMatch[1];
        const nameMatch = identity.match(
          /[\p{Emoji_Presentation}\p{Emoji}\u200d]+\s+(.+?)[\s(]/mu
        );
        if (nameMatch) displayName = nameMatch[1].trim();
      } catch {}

      return {
        id: a.id,
        name: displayName,
        emoji,
        model: a.model || config?.agents?.defaults?.model?.primary || "",
        workspace: a.workspace || "",
      };
    });
  } catch (err) {
    console.error("Failed to read OpenClaw config:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Send message via HTTP API (session-aware)
// ---------------------------------------------------------------------------

export async function sendToAgent(
  agentId: string,
  message: string,
  timeout = 120
): Promise<AgentResponse> {
  // Try HTTP API first (session-aware, faster)
  const httpResult = await sendViaHttp(agentId, message, timeout);
  if (httpResult) return httpResult;

  // Fallback to CLI
  return sendViaCli(agentId, message, timeout);
}

async function sendViaHttp(
  agentId: string,
  message: string,
  timeout: number
): Promise<AgentResponse | null> {
  const gw = getGatewayConfig();
  if (!gw) return null;

  const url = `http://127.0.0.1:${gw.port}/v1/chat/completions`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gw.token}`,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": agentId,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: message }],
        user: `clawcontent:${agentId}`,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.status === 404) {
      // HTTP API not enabled — fall through to CLI
      console.log("⚠️  OpenClaw HTTP API not enabled, using CLI fallback");
      return null;
    }

    if (!res.ok) {
      return {
        success: false,
        message: `Gateway error (${res.status}): ${await res.text()}`,
        raw: "",
      };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content
      || data.result?.payloads?.[0]?.text
      || JSON.stringify(data);

    console.log(`✅ Agent ${agentId} responded via HTTP API (session-aware)`);
    return { success: true, message: text, raw: JSON.stringify(data) };
  } catch (error: any) {
    if (error.name === "AbortError") {
      return { success: false, message: `Agent timeout after ${timeout}s`, raw: "" };
    }
    // Connection refused = gateway not running or HTTP not available
    return null;
  }
}

async function sendViaCli(
  agentId: string,
  message: string,
  timeout: number
): Promise<AgentResponse> {
  try {
    console.log(`📡 Agent ${agentId} via CLI (one-shot, no session)`);
    const result = await $`openclaw agent --agent ${agentId} --message ${message} --json --timeout ${timeout}`.text();

    return { success: true, message: result.trim(), raw: result };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || "";
    const isNotFound = stderr.includes("not found") || stderr.includes("ENOENT")
      || error.message?.includes("not found");

    return {
      success: false,
      message: isNotFound
        ? "OpenClaw not installed. Install from https://docs.openclaw.ai"
        : error.message || "Agent communication failed",
      raw: stderr,
    };
  }
}

// ---------------------------------------------------------------------------
// Parse JSON from agent response
// ---------------------------------------------------------------------------

export function parseAgentJson(response: string): any[] {
  try {
    const parsed = JSON.parse(response);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}

  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
  }

  const arrayMatch = response.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {}
  }

  return [];
}

// ---------------------------------------------------------------------------
// Telegram notification via agent
// ---------------------------------------------------------------------------

export async function notifyTelegram(message: string): Promise<void> {
  try {
    await sendToAgent("main", `ส่งข้อความนี้ใน Telegram: ${message}`, 30);
  } catch {
    console.error("Telegram notify failed:", message);
  }
}
