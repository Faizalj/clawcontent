/**
 * Workflow engine — production profiles that control how content is produced.
 * Users configure style, providers, and resources.
 * The system determines which pipeline steps to run automatically.
 */

import yaml from "js-yaml";
import { readdirSync, readFileSync, existsSync } from "fs";
import { db } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowProfile {
  id: string;
  name: string;
  description: string;
  source: "file" | "db";
  raw_yaml?: string;

  // Production config
  language: string;
  video_duration: string;
  script_format: string;

  // Provider config
  tts_provider: string;
  tts_voice_id: string;
  image_style: string;
  use_lipsync: boolean;

  // Resources
  thumbnail_style: string;
  image_negative: string;
  script_instruction: string;
}

// ---------------------------------------------------------------------------
// DB table
// ---------------------------------------------------------------------------

db.run(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    yaml_content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ---------------------------------------------------------------------------
// Parse YAML → WorkflowProfile
// ---------------------------------------------------------------------------

function parseWorkflow(id: string, raw: string, source: "file" | "db"): WorkflowProfile | null {
  try {
    const p = yaml.load(raw) as any;
    if (!p || !p.name) return null;

    return {
      id,
      name: p.name,
      description: p.description || "",
      source,
      raw_yaml: raw,

      language: p.language || "th",
      video_duration: p.video_duration || "3-4min",
      script_format: p.script_format || "4-section",

      tts_provider: p.tts_provider || "elevenlabs",
      tts_voice_id: p.tts_voice_id || "",
      image_style: p.image_style || "professional illustration, modern, 16:9",
      use_lipsync: p.use_lipsync !== false,

      thumbnail_style: p.thumbnail_style || "gradient",
      image_negative: p.image_negative || "",
      script_instruction: p.script_instruction || "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load from files + DB
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = `${import.meta.dir}/workflows`;

function loadFileWorkflows(): WorkflowProfile[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];

  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.startsWith("_"))
    .map((f) => {
      const raw = readFileSync(`${WORKFLOWS_DIR}/${f}`, "utf-8");
      return parseWorkflow(f.replace(/\.ya?ml$/, ""), raw, "file");
    })
    .filter(Boolean) as WorkflowProfile[];
}

function loadDbWorkflows(): WorkflowProfile[] {
  const rows = db.query("SELECT * FROM workflows ORDER BY name").all() as any[];
  return rows
    .map((r) => parseWorkflow(r.id, r.yaml_content, "db"))
    .filter(Boolean) as WorkflowProfile[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getWorkflows(): WorkflowProfile[] {
  return [...loadFileWorkflows(), ...loadDbWorkflows()];
}

export function getWorkflow(id: string): WorkflowProfile | null {
  return getWorkflows().find((w) => w.id === id) || null;
}

export function saveWorkflow(
  id: string,
  yamlContent: string
): { ok: boolean; error?: string } {
  try {
    const parsed = yaml.load(yamlContent) as any;
    if (!parsed || !parsed.name) {
      return { ok: false, error: "YAML must have a 'name' field" };
    }

    db.run(
      `INSERT OR REPLACE INTO workflows (id, name, description, yaml_content, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [id, parsed.name, parsed.description || "", yamlContent]
    );

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Invalid YAML: ${err.message}` };
  }
}

export function deleteWorkflow(id: string): boolean {
  if (loadFileWorkflows().find((w) => w.id === id)) return false;
  db.run("DELETE FROM workflows WHERE id = ?", [id]);
  return true;
}

/**
 * Determine which pipeline steps to run based on profile config.
 * Steps are always in the correct order — users don't pick them.
 */
export function resolveSteps(profile: WorkflowProfile): string[] {
  // Order: voice → lipsync (main video) → images (inserts) → assembly → captions → thumbnail
  const steps: string[] = ["voice"];

  if (profile.use_lipsync) {
    steps.push("lipsync");
  }

  steps.push("images", "assembly", "captions");

  return steps;
}
