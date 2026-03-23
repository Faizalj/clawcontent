/**
 * Shared helpers for pipeline steps
 */

import { $ } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { getAllSettings } from "../db";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let _envCache: Record<string, string> | null = null;

export function loadEnv(invalidateCache = false): Record<string, string> {
  if (_envCache && !invalidateCache) return _envCache;

  const result: Record<string, string> = {};

  const envPath = `${homedir()}/.env`;
  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  try {
    for (const s of getAllSettings()) {
      if (s.value) result[s.key] = s.value;
    }
  } catch {}

  _envCache = result;
  return result;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export const MODAL_DIR = `${import.meta.dir}/../modal`;
export const TOOLS_DIR = `${import.meta.dir}/../tools`;

export async function runModal(
  script: string,
  args: Record<string, string>
): Promise<string> {
  const env = loadEnv();
  const tokenId = env.MODAL_TOKEN_ID;
  const tokenSecret = env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET required — set in Settings");
  }

  const argList = Object.entries(args).map(
    ([k, v]) => `--${k} ${v}`
  ).join(" ");

  const cmd = `MODAL_TOKEN_ID=${tokenId} MODAL_TOKEN_SECRET=${tokenSecret} modal run ${MODAL_DIR}/${script} ${argList}`;
  console.log(`🔧 Modal: ${script} ${argList.slice(0, 100)}`);

  try {
    const result = await $`bash -c ${cmd}`.text();
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    const detail = stderr || stdout || err.message || "Unknown error";
    console.error(`❌ Modal ${script} failed:`, detail.slice(0, 500));
    throw new Error(`Modal ${script}: ${detail.slice(0, 300)}`);
  }
}

export function parseModalOutput(stdout: string): any {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  throw new Error(`No JSON in Modal output: ${stdout.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------

export function stripScriptForTTS(markdown: string): string {
  return markdown
    .replace(/^#+\s*\[.*?\].*$/gm, "")
    .replace(/^#+\s+.*$/gm, "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/^[\*\-_]{3,}\s*$/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/^\s*\d+\.\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseScriptSections(text: string): { title: string; body: string }[] {
  const parts = text.split(/^## \[/m);
  const sections: { title: string; body: string }[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const newlineIdx = trimmed.indexOf("\n");
    if (newlineIdx === -1) {
      sections.push({ title: trimmed.replace(/\]$/, ""), body: trimmed });
    } else {
      sections.push({
        title: trimmed.slice(0, newlineIdx).replace(/\]$/, "").trim(),
        body: trimmed.slice(newlineIdx + 1).trim(),
      });
    }
  }

  if (sections.length === 0 && text.trim()) {
    sections.push({ title: "Main", body: text.trim() });
  }
  return sections;
}

export function extractAllImagePrompts(scriptText: string): string[] {
  const matches = [...scriptText.matchAll(/<!--\s*image:\s*(.*?)\s*-->/gi)];
  return matches.map(m => m[1].trim()).filter(Boolean);
}

export function buildVisualPrompt(
  section: { title: string; body: string },
  channelName: string,
  style: string = "professional digital illustration, modern, clean, vibrant colors, 16:9"
): string {
  const snippet = section.body.slice(0, 200).replace(/\n/g, " ");
  return `${style}. Video about "${section.title}". Context: ${snippet}. For YouTube channel "${channelName}".`;
}

// ---------------------------------------------------------------------------
// SRT helpers
// ---------------------------------------------------------------------------

export function splitIntoSentences(text: string): string[] {
  const cleaned = text
    .replace(/^#+\s*\[?[^\]]*\]?\s*/gm, "")
    .replace(/\*\*/g, "").replace(/\*/g, "").trim();

  const raw = cleaned.split(/(?<=[.!?\n])\s*/);
  const sentences: string[] = [];

  for (const s of raw) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (trimmed.length > 80) {
      const words = trimmed.split(/\s+/);
      let current = "";
      for (const w of words) {
        if (current.length + w.length + 1 > 60 && current) {
          sentences.push(current.trim());
          current = w;
        } else {
          current += (current ? " " : "") + w;
        }
      }
      if (current.trim()) sentences.push(current.trim());
    } else {
      sentences.push(trimmed);
    }
  }
  return sentences;
}

export function buildSrt(sentences: string[]): string {
  const INTERVAL = 3;
  const lines: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    lines.push(`${i + 1}`);
    lines.push(`${fmtSrt(i * INTERVAL)} --> ${fmtSrt((i + 1) * INTERVAL)}`);
    lines.push(sentences[i]);
    lines.push("");
  }
  return lines.join("\n");
}

export function whisperToSrt(data: any): string {
  const segments = data.segments || [];
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    lines.push(`${i + 1}`);
    lines.push(`${fmtSrt(seg.start)} --> ${fmtSrt(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push("");
  }
  return lines.join("\n");
}

export function fmtSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// GPU Provider routing — Modal or Local
// ---------------------------------------------------------------------------

export function getGpuProvider(): string {
  const env = loadEnv();
  return env.GPU_PROVIDER || "modal";
}

/**
 * Run a GPU task — routes to Modal or Local based on settings.
 * For Local: runs the same Python script directly (needs local GPU + deps).
 */
export async function runGpu(
  script: string,
  args: Record<string, string>
): Promise<string> {
  const provider = getGpuProvider();

  if (provider === "local") {
    return runLocal(script, args);
  }
  return runModal(script, args);
}

async function runLocal(
  script: string,
  args: Record<string, string>
): Promise<string> {
  // Run Python script directly — requires local GPU + dependencies
  const scriptPath = `${MODAL_DIR}/${script}`;
  const argList = Object.entries(args).map(
    ([k, v]) => `--${k} ${v}`
  ).join(" ");

  const cmd = `python3 ${scriptPath} ${argList}`;
  console.log(`🖥️  Local GPU: ${script} ${argList.slice(0, 100)}`);

  try {
    const result = await $`bash -c ${cmd}`.text();
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const detail = stderr || err.message || "Unknown error";
    console.error(`❌ Local ${script} failed:`, detail.slice(0, 500));
    throw new Error(`Local ${script}: ${detail.slice(0, 300)}`);
  }
}

// Re-export common deps for steps
export { $, mkdirSync, writeFileSync, readFileSync, existsSync, homedir };
