/**
 * Step Loader — auto-discovers pipeline steps from this directory
 *
 * Any .ts file in steps/ that exports a PipelineStep will be registered.
 * Validates step contracts (requires/provides) before execution.
 */

import { readdirSync } from "fs";
import type { PipelineStep, PipelineContext } from "./types";

const STEPS_DIR = import.meta.dir;

const stepRegistry: Map<string, PipelineStep> = new Map();

// Auto-discover and load all step files
const files = readdirSync(STEPS_DIR).filter(
  (f) => f.endsWith(".ts") && !["index.ts", "types.ts", "helpers.ts"].includes(f)
);

for (const file of files) {
  try {
    const mod = require(`./${file.replace(".ts", "")}`);
    const step: PipelineStep = mod.default || mod;
    if (step && step.name && step.execute) {
      stepRegistry.set(step.name, step);
    }
  } catch (err) {
    console.warn(`⚠️  Failed to load step ${file}:`, err);
  }
}

console.log(`📦 Loaded ${stepRegistry.size} pipeline steps: ${[...stepRegistry.keys()].join(", ")}`);

export function getStep(name: string): PipelineStep | undefined {
  return stepRegistry.get(name);
}

export function getAvailableSteps(): string[] {
  return [...stepRegistry.keys()];
}

/**
 * Validate that a step's requirements are met by current context.
 * Returns missing fields or empty array if OK.
 */
export function validateStep(step: PipelineStep, ctx: PipelineContext): string[] {
  const missing: string[] = [];
  for (const req of step.requires) {
    const val = (ctx as any)[req];
    if (val === null || val === undefined || val === "" || (Array.isArray(val) && val.length === 0)) {
      missing.push(req);
    }
  }
  return missing;
}

/**
 * Update context with step output based on provides contract.
 */
export function populateContext(ctx: PipelineContext, step: PipelineStep, outputPath: string) {
  for (const field of step.provides) {
    if (field === "imagePaths") {
      try { (ctx as any)[field] = JSON.parse(outputPath); } catch { (ctx as any)[field] = [outputPath]; }
    } else {
      (ctx as any)[field] = outputPath || null;
    }
  }
}

export type { PipelineStep, PipelineContext } from "./types";
