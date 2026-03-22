/**
 * Pipeline Orchestrator
 *
 * No step logic here — just orchestration.
 * Steps are plugins in steps/ directory, auto-discovered.
 */

import {
  getContentById,
  getChannel,
  getScript,
  updateContentStatus,
  createPipelineJob,
  updatePipelineJob,
  getPipelineJobs,
  deletePipelineJobs,
} from "./db";
import { getWorkflow, resolveSteps } from "./workflow";
import { getStep, getAvailableSteps, validateStep, populateContext } from "./steps";
import { loadEnv } from "./steps/helpers";
import type { PipelineContext } from "./steps/types";

// Re-export for server.ts
export { loadEnv };

// ---------------------------------------------------------------------------
// Pipeline orchestration
// ---------------------------------------------------------------------------

function outputDirFor(channelId: string, contentId: number): string {
  const { mkdirSync } = require("fs");
  const dir = `${import.meta.dir}/output/${channelId}/${contentId}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function startPipeline(contentId: number): Promise<void> {
  const content = getContentById(contentId) as any;
  if (!content) throw new Error(`Content not found: ${contentId}`);

  const channel = getChannel(content.channel_id) as any;
  if (!channel) throw new Error(`Channel not found: ${content.channel_id}`);

  // Resolve steps from workflow profile
  const profile = channel.workflow_id ? getWorkflow(channel.workflow_id) : null;
  const available = getAvailableSteps();
  const steps = profile
    ? resolveSteps(profile).filter((s) => available.includes(s))
    : available;

  if (steps.length === 0) {
    throw new Error("No pipeline steps available");
  }

  // Clean old jobs and create fresh ones
  deletePipelineJobs(contentId);
  for (let i = 0; i < steps.length; i++) {
    createPipelineJob({ content_id: contentId, step_name: steps[i], step_order: i, status: "pending" });
  }

  updateContentStatus(contentId, "producing");
  console.log(`🚀 Pipeline started for content ${contentId}: ${steps.join(" → ")}`);
  await runPipeline(contentId);
}

export async function runPipeline(contentId: number): Promise<void> {
  const content = getContentById(contentId) as any;
  if (!content) throw new Error(`Content not found: ${contentId}`);

  const channel = getChannel(content.channel_id) as any;
  if (!channel) throw new Error(`Channel not found: ${content.channel_id}`);

  const script = getScript(contentId) as any;
  if (!script) throw new Error(`No script found for content: ${contentId}`);

  const scriptText = script.approved_text || script.draft_text;
  if (!scriptText) throw new Error("No script text available");

  const profile = channel.workflow_id ? getWorkflow(channel.workflow_id) : null;

  const ctx: PipelineContext = {
    outputDir: outputDirFor(content.channel_id, contentId),
    scriptText,
    voicePath: null,
    imagePaths: [],
    lipsyncPath: null,
    assembledPath: null,
    captionsPath: null,
    channel,
    content,
    env: loadEnv(),
    profile,
  };

  const jobs = getPipelineJobs(contentId);
  if (!jobs || jobs.length === 0) return;

  // Pre-populate context from completed steps
  for (const job of jobs) {
    if (job.status === "done" && job.output_path) {
      const step = getStep(job.step);
      if (step) populateContext(ctx, step, job.output_path);
    }
  }

  for (const job of jobs) {
    if (job.status === "done") continue;

    const step = getStep(job.step);
    if (!step) {
      console.warn(`⚠️  Unknown step: ${job.step}`);
      continue;
    }

    // Validate step requirements
    const missing = validateStep(step, ctx);
    if (missing.length > 0) {
      console.warn(`⚠️  Step ${job.step} requires [${missing.join(", ")}] — skipping`);
      updatePipelineJob(job.id, {
        status: "failed",
        error: `Missing required: ${missing.join(", ")}`,
        completed_at: new Date().toISOString(),
      });
      return;
    }

    updatePipelineJob(job.id, { status: "running", started_at: new Date().toISOString() });

    try {
      console.log(`▶️  Running step: ${job.step} (${step.description})`);
      const output = await step.execute(contentId, ctx);
      const outputPath = Array.isArray(output) ? JSON.stringify(output) : output;

      updatePipelineJob(job.id, { status: "done", output_path: outputPath, error: null, completed_at: new Date().toISOString() });
      populateContext(ctx, step, outputPath);
    } catch (err: any) {
      const stderr = err.stderr?.toString?.() || "";
      const errorMsg = (err instanceof Error ? err.message : String(err)) + (stderr ? ` | ${stderr.slice(0, 200)}` : "");
      console.error(`❌ Step ${job.step} failed: ${errorMsg}`);
      updatePipelineJob(job.id, { status: "failed", error: errorMsg, completed_at: new Date().toISOString() });
      return;
    }
  }

  if (getPipelineJobs(contentId).every((j: any) => j.status === "done")) {
    updateContentStatus(contentId, "produced");
    console.log(`🎉 Pipeline complete for content ${contentId}`);
  }
}

export async function retryStep(contentId: number, stepName: string): Promise<void> {
  const jobs = getPipelineJobs(contentId);
  const job = jobs.find((j: any) => j.step === stepName && (j.status === "failed" || j.status === "done"));
  if (!job) throw new Error(`No retryable job for step "${stepName}" on content ${contentId}`);

  // Reset this step + all downstream steps
  updatePipelineJob(job.id, { status: "pending", error: null, output_path: null });
  updateContentStatus(contentId, "producing");

  let foundTarget = false;
  for (const j of jobs) {
    if (j.id === job.id) { foundTarget = true; continue; }
    if (foundTarget && j.status !== "pending") {
      updatePipelineJob(j.id, { status: "pending", error: null, output_path: null });
    }
  }

  console.log(`🔄 Retrying step: ${stepName}`);
  await runPipeline(contentId);
}
