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

  // Video format
  orientation: string;        // landscape | portrait | square
  resolution: string;         // 1280x720 | 1080x1920 | 1080x1080
  video_duration: string;     // 1min | 3-4min | 5-7min | 10min+

  // Content
  content_mode: string;       // standalone | series
  language: string;           // th | en
  script_format: string;      // 2-section | 4-section
  script_instruction: string; // custom prompt for agent

  // Voice
  tts_provider: string;       // elevenlabs | chatterbox | f5tts-thai
  tts_voice_id: string;       // ElevenLabs voice clone ID

  // Visual
  image_style: string;        // AI image generation style prompt
  image_negative: string;     // negative prompt for image gen
  use_lipsync: boolean;       // enable lipsync (needs avatar)

  // Insert
  insert_interval: number;    // insert image every N seconds
  insert_duration: number;    // each insert shows for N seconds

  // Output
  thumbnail_style: string;    // gradient | minimal

  // Compute (reserved)
  gpu_provider: string;       // modal | comfyui-local | comfyui-cloud
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

      // Video format
      orientation: p.orientation || "landscape",
      resolution: p.resolution || (p.orientation === "portrait" ? "1080x1920" : "1280x720"),
      video_duration: p.video_duration || "3-4min",

      // Content
      content_mode: p.content_mode || "standalone",
      language: p.language || "th",
      script_format: p.script_format || "4-section",
      script_instruction: p.script_instruction || "",

      // Voice
      tts_provider: p.tts_provider || "elevenlabs",
      tts_voice_id: p.tts_voice_id || "",

      // Visual
      image_style: p.image_style || "professional illustration, modern, 16:9",
      image_negative: p.image_negative || "",
      use_lipsync: p.use_lipsync !== false,

      // Insert
      insert_interval: p.insert_interval || 20,
      insert_duration: p.insert_duration || 5,

      // Output
      thumbnail_style: p.thumbnail_style || "gradient",

      // Compute
      gpu_provider: p.gpu_provider || "modal",
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
