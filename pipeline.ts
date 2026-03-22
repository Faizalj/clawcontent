import { $ } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import {
  getContentById,
  getChannel,
  getScript,
  updateContentStatus,
  createPipelineJob,
  updatePipelineJob,
  getPipelineJobs,
  deletePipelineJobs,
  getAllSettings,
} from "./db";
import { getWorkflow, type WorkflowStepConfig } from "./workflow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineContext {
  outputDir: string;
  scriptText: string;
  voicePath: string | null;
  imagePaths: string[];
  lipsyncPath: string | null;
  captionsPath: string | null;
  channel: any;
  content: any;
  env: Record<string, string>;
  workflowSteps: WorkflowStepConfig[];
}

type StepFn = (
  contentId: number,
  context: PipelineContext
) => Promise<string | string[]>;

// ---------------------------------------------------------------------------
// Environment — DB settings override ~/.env
// ---------------------------------------------------------------------------

let _envCache: Record<string, string> | null = null;

export function loadEnv(invalidateCache = false): Record<string, string> {
  if (_envCache && !invalidateCache) return _envCache;

  const result: Record<string, string> = {};

  // Layer 1: ~/.env file
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

  // Layer 2: DB settings override
  try {
    for (const s of getAllSettings()) {
      if (s.value) result[s.key] = s.value;
    }
  } catch {}

  _envCache = result;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outputDirFor(channelId: string, contentId: number): string {
  const dir = `${import.meta.dir}/output/${channelId}/${contentId}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MODAL_DIR = `${import.meta.dir}/modal`;

/**
 * Run a Modal script and return stdout. Sets MODAL_TOKEN_ID/SECRET from env.
 */
async function runModal(
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
  console.log(`🔧 Modal: ${script} ${argList}`);

  const result = await $`bash -c ${cmd}`.text();
  return result.trim();
}

/**
 * Parse JSON from last line of Modal stdout (scripts print JSON as last line)
 */
function parseModalOutput(stdout: string): any {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  throw new Error(`No JSON in Modal output: ${stdout.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

// ---- VOICE (3 providers) ----

async function stepVoice(contentId: number, ctx: PipelineContext): Promise<string> {
  // Provider from workflow config > channel tts_provider > default
  const wfStep = ctx.workflowSteps.find((s) => s.name === "voice");
  const ttsProvider = wfStep?.provider || ctx.channel.tts_provider || "elevenlabs";
  const outPath = `${ctx.outputDir}/voice.mp3`;

  if (ttsProvider === "elevenlabs") {
    await voiceElevenLabs(ctx.scriptText, outPath, ctx.env);
  } else if (ttsProvider === "chatterbox") {
    await voiceModal("chatterbox_tts.py", ctx.scriptText, outPath, ctx.channel.avatar_url);
  } else if (ttsProvider === "f5tts-thai") {
    await voiceModal("f5tts_thai.py", ctx.scriptText, outPath, ctx.channel.avatar_url);
  } else {
    throw new Error(`Unknown TTS provider: ${ttsProvider}`);
  }

  ctx.voicePath = outPath;
  console.log(`✅ Voice generated (${ttsProvider}): ${outPath}`);
  return outPath;
}

async function voiceElevenLabs(text: string, outPath: string, env: Record<string, string>) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set — add in Settings");

  const res = await fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/camsOHfnF030L7enGMzZ",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_v3",
        language_code: "th",
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${body}`);
  }

  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

async function voiceModal(script: string, text: string, outPath: string, referenceAudio?: string) {
  const args: Record<string, string> = {
    text: `"${text.replace(/"/g, '\\"').slice(0, 5000)}"`,
    "output-path": outPath,
  };
  if (referenceAudio) {
    args["reference-audio"] = referenceAudio;
  }

  const stdout = await runModal(script, args);
  const result = parseModalOutput(stdout);
  if (result.status !== "completed") {
    throw new Error(`Modal TTS failed: ${JSON.stringify(result)}`);
  }
}

// ---- IMAGES (Flux on Modal) ----

async function stepImages(contentId: number, ctx: PipelineContext): Promise<string> {
  const sections = parseScriptSections(ctx.scriptText);
  if (sections.length === 0) {
    throw new Error("No sections found in script to generate images from");
  }

  const wfStep = ctx.workflowSteps.find((s) => s.name === "images");
  const imageStyle = wfStep?.config?.style || "professional digital illustration, modern, clean, vibrant colors, 16:9";

  const paths: string[] = [];

  for (let i = 0; i < sections.length; i++) {
    const visualPrompt = buildVisualPrompt(sections[i], ctx.channel.name, imageStyle);
    const imgPath = `${ctx.outputDir}/img_${i}.jpeg`;

    console.log(`🖼️  Generating image ${i + 1}/${sections.length} via Flux...`);

    const stdout = await runModal("flux_image.py", {
      prompt: `"${visualPrompt.replace(/"/g, '\\"')}"`,
      "output-path": imgPath,
    });

    const result = parseModalOutput(stdout);
    if (result.status !== "completed") {
      throw new Error(`Flux image gen failed: ${JSON.stringify(result)}`);
    }

    paths.push(imgPath);
    console.log(`✅ Image ${i + 1} saved: ${imgPath}`);
  }

  ctx.imagePaths = paths;
  return JSON.stringify(paths);
}

// ---- LIPSYNC (LTX-2.3 on Modal) ----

async function stepLipsync(contentId: number, ctx: PipelineContext): Promise<string> {
  const avatarUrl = ctx.channel.avatar_url;
  if (!avatarUrl) {
    console.log("⏭️  Skipping lipsync — no avatar_url on channel");
    return "";
  }

  if (!ctx.voicePath) {
    throw new Error("Voice audio not available for lipsync");
  }

  console.log("🎭 Starting lipsync via Modal LTX-2.3...");
  const outPath = `${ctx.outputDir}/lipsync.mp4`;

  const stdout = await runModal("lipsync.py", {
    "audio-path": ctx.voicePath,
    "image-path": avatarUrl,
    "output-path": outPath,
  });

  const result = parseModalOutput(stdout);
  if (result.status !== "completed") {
    throw new Error(`Lipsync failed: ${JSON.stringify(result)}`);
  }

  ctx.lipsyncPath = outPath;
  console.log(`✅ Lipsync video saved: ${outPath}`);
  return outPath;
}

// ---- CAPTIONS (local Whisper + fallback) ----

async function stepCaptions(contentId: number, ctx: PipelineContext): Promise<string> {
  const outPath = `${ctx.outputDir}/captions.srt`;

  // Try local Whisper first
  if (ctx.voicePath) {
    try {
      console.log("🎤 Running local Whisper for captions...");
      const whisperJsonPath = `${ctx.outputDir}/whisper.json`;
      await $`whisper ${ctx.voicePath} --model turbo --output_format json --output_dir ${ctx.outputDir} --word_timestamps True`.quiet();

      // Whisper outputs {voice}.json — find it
      const baseName = ctx.voicePath.split("/").pop()!.replace(/\.[^.]+$/, "");
      const whisperOut = `${ctx.outputDir}/${baseName}.json`;

      if (existsSync(whisperOut)) {
        const whisperData = JSON.parse(readFileSync(whisperOut, "utf-8"));
        const srt = whisperToSrt(whisperData);
        writeFileSync(outPath, srt, "utf-8");
        ctx.captionsPath = outPath;
        console.log(`✅ Captions from Whisper: ${outPath}`);
        return outPath;
      }
    } catch (err: any) {
      console.warn(`⚠️  Whisper failed, falling back to script-based SRT: ${err.message}`);
    }
  }

  // Fallback: generate SRT from script text
  const sentences = splitIntoSentences(ctx.scriptText);
  const srt = buildSrt(sentences);
  writeFileSync(outPath, srt, "utf-8");
  ctx.captionsPath = outPath;
  console.log(`✅ Captions from script text: ${outPath} (${sentences.length} entries)`);
  return outPath;
}

// ---- ASSEMBLY (local ffmpeg) ----

async function stepAssembly(contentId: number, ctx: PipelineContext): Promise<string> {
  const outPath = `${ctx.outputDir}/final.mp4`;

  if (ctx.lipsyncPath && existsSync(ctx.lipsyncPath)) {
    console.log("🎬 Assembling: lipsync video + captions...");
    if (ctx.captionsPath && existsSync(ctx.captionsPath)) {
      await $`ffmpeg -y -i ${ctx.lipsyncPath} -vf subtitles=${ctx.captionsPath} -c:a copy ${outPath}`.quiet();
    } else {
      await $`cp ${ctx.lipsyncPath} ${outPath}`.quiet();
    }
  } else if (ctx.imagePaths.length > 0 && ctx.voicePath) {
    console.log("🎬 Assembling: slideshow + voice + captions...");

    const concatPath = `${ctx.outputDir}/images.txt`;
    const dur = 3;
    const concatContent = ctx.imagePaths
      .map((p) => `file '${p}'\nduration ${dur}`)
      .join("\n") + `\nfile '${ctx.imagePaths[ctx.imagePaths.length - 1]}'`;
    writeFileSync(concatPath, concatContent, "utf-8");

    const slideshowPath = `${ctx.outputDir}/slideshow.mp4`;
    await $`ffmpeg -y -f concat -safe 0 -i ${concatPath} -vsync vfr -pix_fmt yuv420p ${slideshowPath}`.quiet();

    const combinedPath = `${ctx.outputDir}/combined.mp4`;
    await $`ffmpeg -y -i ${slideshowPath} -i ${ctx.voicePath} -c:v copy -c:a aac -shortest ${combinedPath}`.quiet();

    if (ctx.captionsPath && existsSync(ctx.captionsPath)) {
      await $`ffmpeg -y -i ${combinedPath} -vf subtitles=${ctx.captionsPath} -c:a copy ${outPath}`.quiet();
    } else {
      await $`cp ${combinedPath} ${outPath}`.quiet();
    }
  } else {
    throw new Error("Assembly requires either lipsync video or images + voice audio");
  }

  console.log(`✅ Final video assembled: ${outPath}`);
  return outPath;
}

// ---- THUMBNAIL (Playwright) ----

async function stepThumbnail(contentId: number, ctx: PipelineContext): Promise<string> {
  console.log("📸 Generating thumbnail via Playwright...");

  const templatePath = `${import.meta.dir}/thumbnail.html`;
  if (!existsSync(templatePath)) {
    throw new Error("thumbnail.html template not found");
  }

  let html = readFileSync(templatePath, "utf-8");
  const accent = ctx.channel.accent_color || "#FF6600";

  // Generate gradient colors from accent
  const bgFrom = "#1a1a2e";
  const bgTo = accent + "88";

  html = html
    .replace(/\{\{CHANNEL\}\}/g, escapeHtml(ctx.channel.name))
    .replace(/\{\{TITLE\}\}/g, escapeHtml(ctx.content.title))
    .replace(/\{\{ACCENT\}\}/g, accent)
    .replace(/\{\{BG_FROM\}\}/g, bgFrom)
    .replace(/\{\{BG_TO\}\}/g, bgTo)
    .replace(/\{\{EP_BADGE\}\}/g, ctx.content.ep_number
      ? `<div class="ep-badge">EP ${escapeHtml(ctx.content.ep_number)}</div>`
      : "");

  const tempHtml = `${ctx.outputDir}/thumbnail_temp.html`;
  writeFileSync(tempHtml, html, "utf-8");

  const outPath = `${ctx.outputDir}/thumbnail.png`;

  // Use Playwright CLI to screenshot
  try {
    await $`npx playwright screenshot --viewport-size 1280,720 file://${tempHtml} ${outPath}`.quiet();
  } catch (e1: any) {
    try {
      await $`bunx playwright screenshot --viewport-size 1280,720 file://${tempHtml} ${outPath}`.quiet();
    } catch (e2: any) {
      console.warn("⚠️  Playwright not installed — skipping thumbnail. Install: npx playwright install chromium");
      return "";
    }
  }

  console.log(`✅ Thumbnail saved: ${outPath}`);
  return outPath;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Script parsing & SRT helpers
// ---------------------------------------------------------------------------

function parseScriptSections(text: string): { title: string; body: string }[] {
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

function buildVisualPrompt(
  section: { title: string; body: string },
  channelName: string,
  style: string = "professional digital illustration, modern, clean, vibrant colors, 16:9"
): string {
  const snippet = section.body.slice(0, 200).replace(/\n/g, " ");
  return `${style}. Video about "${section.title}". Context: ${snippet}. For YouTube channel "${channelName}".`;
}

function splitIntoSentences(text: string): string[] {
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

function buildSrt(sentences: string[]): string {
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

function whisperToSrt(data: any): string {
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

function fmtSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

const STEP_FUNCTIONS: Record<string, StepFn> = {
  voice: stepVoice,
  images: stepImages,
  lipsync: stepLipsync,
  captions: stepCaptions,
  assembly: stepAssembly,
  thumbnail: stepThumbnail,
};

const IMPLEMENTED_STEPS = Object.keys(STEP_FUNCTIONS);

// ---------------------------------------------------------------------------
// Pipeline orchestration
// ---------------------------------------------------------------------------

export async function startPipeline(contentId: number): Promise<void> {
  const content = getContentById(contentId) as any;
  if (!content) throw new Error(`Content not found: ${contentId}`);

  const channel = getChannel(content.channel_id) as any;
  if (!channel) throw new Error(`Channel not found: ${content.channel_id}`);

  // Resolve steps from workflow (preferred) or fallback to pipeline_steps
  let steps: string[];
  const workflowId = channel.workflow_id;
  if (workflowId) {
    const wf = getWorkflow(workflowId);
    if (wf) {
      steps = wf.steps.map((s) => s.name).filter((s) => IMPLEMENTED_STEPS.includes(s));
    } else {
      console.warn(`⚠️  Workflow "${workflowId}" not found, falling back to pipeline_steps`);
      steps = JSON.parse(channel.pipeline_steps || "[]").filter((s: string) => IMPLEMENTED_STEPS.includes(s));
    }
  } else {
    steps = JSON.parse(channel.pipeline_steps || "[]").filter((s: string) => IMPLEMENTED_STEPS.includes(s));
  }

  if (steps.length === 0) {
    throw new Error("No implementable pipeline steps configured on channel");
  }

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

  // Load workflow config for step-level settings
  const wf = channel.workflow_id ? getWorkflow(channel.workflow_id) : null;

  const ctx: PipelineContext = {
    outputDir: outputDirFor(content.channel_id, contentId),
    scriptText,
    voicePath: null,
    imagePaths: [],
    lipsyncPath: null,
    captionsPath: null,
    channel,
    content,
    env: loadEnv(),
    workflowSteps: wf?.steps || [],
  };

  const jobs = getPipelineJobs(contentId);
  if (!jobs || jobs.length === 0) return;

  // Pre-populate from completed steps
  for (const job of jobs) {
    if (job.status === "done" && job.output_path) populateContext(ctx, job.step, job.output_path);
  }

  for (const job of jobs) {
    if (job.status === "done") continue;

    const stepFn = STEP_FUNCTIONS[job.step];
    if (!stepFn) { console.warn(`⚠️  Unknown step: ${job.step}`); continue; }

    updatePipelineJob(job.id, { status: "running", started_at: new Date().toISOString() });

    try {
      console.log(`▶️  Running step: ${job.step}...`);
      const output = await stepFn(contentId, ctx);
      const outputPath = Array.isArray(output) ? JSON.stringify(output) : output;

      updatePipelineJob(job.id, { status: "done", output_path: outputPath, completed_at: new Date().toISOString() });
      populateContext(ctx, job.step, outputPath);
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Step ${job.step} failed: ${errorMsg}`);
      updatePipelineJob(job.id, { status: "failed", error: errorMsg, completed_at: new Date().toISOString() });
      return;
    }
  }

  if (getPipelineJobs(contentId).every((j: any) => j.status === "done")) {
    updateContentStatus(contentId, "done");
    console.log(`🎉 Pipeline complete for content ${contentId}`);
  }
}

export async function retryStep(contentId: number, stepName: string): Promise<void> {
  const job = getPipelineJobs(contentId).find((j: any) => j.step === stepName && j.status === "failed");
  if (!job) throw new Error(`No failed job for step "${stepName}" on content ${contentId}`);

  updatePipelineJob(job.id, { status: "pending", error: null, output_path: null });
  console.log(`🔄 Retrying step: ${stepName}`);
  await runPipeline(contentId);
}

function populateContext(ctx: PipelineContext, step: string, outputPath: string) {
  switch (step) {
    case "voice": ctx.voicePath = outputPath; break;
    case "images":
      try { ctx.imagePaths = JSON.parse(outputPath); } catch { ctx.imagePaths = [outputPath]; }
      break;
    case "lipsync": ctx.lipsyncPath = outputPath || null; break;
    case "captions": ctx.captionsPath = outputPath; break;
  }
}
