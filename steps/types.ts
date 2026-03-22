/**
 * Pipeline Step Plugin Interface
 *
 * Each step is a separate file in steps/ that exports a PipelineStep.
 * Pipeline engine auto-discovers and registers all steps.
 *
 * To create a new step:
 * 1. Create a new .ts file in steps/
 * 2. Export default: { name, description, requires, provides, execute }
 * 3. Add step name to workflow YAML
 * 4. Done — pipeline will pick it up automatically
 *
 * Step Contract:
 * - requires: PipelineContext fields that MUST exist before this step runs
 * - optionalRequires: fields that are used IF available
 * - provides: PipelineContext fields this step will populate
 */

import type { WorkflowProfile } from "../workflow";

export interface PipelineContext {
  outputDir: string;
  scriptText: string;
  voicePath: string | null;
  imagePaths: string[];
  lipsyncPath: string | null;
  assembledPath: string | null;
  captionsPath: string | null;
  channel: any;
  content: any;
  env: Record<string, string>;
  profile: WorkflowProfile | null;
  /** Dynamic outputs from steps — steps can read/write freely */
  [key: string]: any;
}

export interface PipelineStep {
  /** Unique step name — matches workflow YAML step names */
  name: string;
  /** Human-readable description */
  description: string;
  /** Context fields that MUST be set before this step runs */
  requires: (keyof PipelineContext | string)[];
  /** Context fields that are used if available but not required */
  optionalRequires?: (keyof PipelineContext | string)[];
  /** Context fields this step will set after completion */
  provides: (keyof PipelineContext | string)[];
  /** Execute the step. Returns output path or empty string. */
  execute: (contentId: number, ctx: PipelineContext) => Promise<string>;
}
