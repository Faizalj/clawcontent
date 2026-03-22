/**
 * Workflow engine — loads, parses, and manages pipeline workflow YAML configs.
 * Workflows define the steps, providers, and style config for content production.
 *
 * Sources:
 *   1. File-based: workflows/*.yaml (default/shared templates)
 *   2. DB-based: workflows table (user-created via dashboard)
 */

import yaml from "js-yaml";
import { readdirSync, readFileSync, existsSync } from "fs";
import { db } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowStepConfig {
  name: string;
  provider: string;
  config?: Record<string, any>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStepConfig[];
  source: "file" | "db";
  raw_yaml?: string;
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
// File-based workflows
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = `${import.meta.dir}/workflows`;

function loadFileWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];

  const files = readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );

  const workflows: Workflow[] = [];

  for (const file of files) {
    try {
      const filePath = `${WORKFLOWS_DIR}/${file}`;
      const raw = readFileSync(filePath, "utf-8");
      const parsed = yaml.load(raw) as any;

      if (!parsed || !parsed.name || !parsed.steps) continue;

      const id = file.replace(/\.ya?ml$/, "");
      workflows.push({
        id,
        name: parsed.name,
        description: parsed.description || "",
        steps: (parsed.steps || []).map((s: any) => ({
          name: s.name,
          provider: s.provider || "default",
          config: s.config || {},
        })),
        source: "file",
        raw_yaml: raw,
      });
    } catch (err) {
      console.warn(`⚠️  Failed to parse workflow ${file}:`, err);
    }
  }

  return workflows;
}

// ---------------------------------------------------------------------------
// DB-based workflows
// ---------------------------------------------------------------------------

function loadDbWorkflows(): Workflow[] {
  const rows = db
    .query("SELECT * FROM workflows ORDER BY name")
    .all() as any[];

  return rows.map((row) => {
    try {
      const parsed = yaml.load(row.yaml_content) as any;
      return {
        id: row.id,
        name: parsed?.name || row.name,
        description: parsed?.description || row.description || "",
        steps: (parsed?.steps || []).map((s: any) => ({
          name: s.name,
          provider: s.provider || "default",
          config: s.config || {},
        })),
        source: "db" as const,
        raw_yaml: row.yaml_content,
      };
    } catch {
      return {
        id: row.id,
        name: row.name,
        description: row.description || "",
        steps: [],
        source: "db" as const,
        raw_yaml: row.yaml_content,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getWorkflows(): Workflow[] {
  return [...loadFileWorkflows(), ...loadDbWorkflows()];
}

export function getWorkflow(id: string): Workflow | null {
  const all = getWorkflows();
  return all.find((w) => w.id === id) || null;
}

export function saveWorkflow(
  id: string,
  yamlContent: string
): { ok: boolean; error?: string } {
  // Validate YAML
  try {
    const parsed = yaml.load(yamlContent) as any;
    if (!parsed || !parsed.name) {
      return { ok: false, error: "YAML must have a 'name' field" };
    }
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return { ok: false, error: "YAML must have a non-empty 'steps' array" };
    }
    for (const step of parsed.steps) {
      if (!step.name) {
        return { ok: false, error: "Each step must have a 'name' field" };
      }
    }

    const name = parsed.name;
    const description = parsed.description || "";

    db.run(
      `INSERT OR REPLACE INTO workflows (id, name, description, yaml_content, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [id, name, description, yamlContent]
    );

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Invalid YAML: ${err.message}` };
  }
}

export function deleteWorkflow(id: string): boolean {
  // Only delete DB workflows, not file-based
  const fileWorkflows = loadFileWorkflows();
  if (fileWorkflows.find((w) => w.id === id)) {
    return false; // Can't delete file-based workflows
  }

  db.run("DELETE FROM workflows WHERE id = ?", [id]);
  return true;
}

/**
 * Get the step names from a workflow (for pipeline job creation)
 */
export function getWorkflowStepNames(workflow: Workflow): string[] {
  return workflow.steps.map((s) => s.name);
}

/**
 * Get step config from workflow for a specific step
 */
export function getStepConfig(
  workflow: Workflow,
  stepName: string
): WorkflowStepConfig | null {
  return workflow.steps.find((s) => s.name === stepName) || null;
}
