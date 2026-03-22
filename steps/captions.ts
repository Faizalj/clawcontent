import type { PipelineStep, PipelineContext } from "./types";
import {
  $,
  writeFileSync,
  readFileSync,
  existsSync,
  whisperToSrt,
  TOOLS_DIR,
} from "./helpers";

const step: PipelineStep = {
  name: "captions",
  description: "Whisper transcription + fix typos + Playwright burn captions",
  requires: ["scriptText", "assembledPath"],
  optionalRequires: ["voicePath"],
  provides: ["captionsPath"],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    // Runs AFTER assembly
    const assembledVideo = `${ctx.outputDir}/final.mp4`;
    const whisperJson = `${ctx.outputDir}/whisper_raw.json`;
    const fixedJson = `${ctx.outputDir}/captions_fixed.json`;
    const scriptPath = `${ctx.outputDir}/script.md`;
    const captionedVideo = `${ctx.outputDir}/final_captioned.mp4`;

    // Save script text as .md for fix_caption_typos.py
    // Strip image prompts + markdown before giving to fix_caption_typos
    const cleanScript = ctx.scriptText
      .replace(/<!--.*?-->/gs, "")
      .replace(/^#+\s*\[.*?\].*$/gm, "")
      .replace(/^#+\s+.*$/gm, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/\(.*?\)/g, "")
      .replace(/^[\*\-_]{3,}\s*$/gm, "")
      .trim();
    writeFileSync(scriptPath, cleanScript, "utf-8");

    const audioSource = existsSync(assembledVideo)
      ? assembledVideo
      : ctx.voicePath;
    if (!audioSource) throw new Error("No audio source for captions");

    // Step 1: Whisper → JSON (timing accurate, text may have errors)
    console.log(`🎤 Step 1: Whisper transcription...`);
    try {
      await $`whisper ${audioSource} --model turbo --output_format json --output_dir ${ctx.outputDir} --word_timestamps True`.quiet();

      // Whisper outputs {basename}.json — rename to whisper_raw.json
      const baseName = audioSource
        .split("/")
        .pop()!
        .replace(/\.[^.]+$/, "");
      const whisperOut = `${ctx.outputDir}/${baseName}.json`;
      if (existsSync(whisperOut)) {
        await $`cp ${whisperOut} ${whisperJson}`.quiet();
        console.log(`✅ Whisper JSON: ${whisperJson}`);
      }
    } catch (err: any) {
      console.warn(`⚠️  Whisper failed: ${err.message}`);
    }

    // Step 2: Fix typos — align Whisper text with script (correct Thai text)
    if (existsSync(whisperJson) && existsSync(scriptPath)) {
      console.log(`🔤 Step 2: Fixing caption typos (script alignment)...`);
      try {
        await $`python3 ${TOOLS_DIR}/fix_caption_typos.py --whisper ${whisperJson} --script ${scriptPath} --output ${fixedJson}`.quiet();
        console.log(`✅ Fixed captions: ${fixedJson}`);
      } catch (err: any) {
        console.warn(
          `⚠️  Fix typos failed: ${err.message} — using raw Whisper`
        );
        if (!existsSync(fixedJson)) {
          await $`cp ${whisperJson} ${fixedJson}`.quiet();
        }
      }
    } else if (existsSync(whisperJson)) {
      // No script to compare — use raw Whisper
      await $`cp ${whisperJson} ${fixedJson}`.quiet();
    }

    // Step 3: Burn captions via Playwright (HTML render — Thai font safe)
    const transcriptForBurn = existsSync(fixedJson) ? fixedJson : whisperJson;

    if (existsSync(assembledVideo) && existsSync(transcriptForBurn)) {
      console.log(`🎨 Step 3: Burning captions via Playwright...`);
      try {
        const cp2 = require("child_process");
        const burnResult = cp2.spawnSync(
          "python3",
          [
            `${TOOLS_DIR}/animated_caption.py`,
            "--transcript",
            transcriptForBurn,
            "--video",
            assembledVideo,
            "--output",
            captionedVideo,
          ],
          { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }
        );

        if (burnResult.stdout)
          console.log(burnResult.stdout.toString().slice(-500));
        if (burnResult.status !== 0) {
          const errMsg =
            burnResult.stderr?.toString()?.slice(-300) || "Unknown error";
          throw new Error(
            `Playwright burn exit ${burnResult.status}: ${errMsg}`
          );
        }

        if (existsSync(captionedVideo)) {
          await $`mv ${captionedVideo} ${assembledVideo}`.quiet();
          console.log(
            `✅ Captions burned with Playwright — Thai font perfect`
          );
        }
      } catch (err: any) {
        console.warn(`⚠️  Playwright burn failed: ${err.message}`);

        // Fallback: embed soft subtitles
        try {
          const srtPath = `${ctx.outputDir}/captions.srt`;
          if (existsSync(transcriptForBurn)) {
            const data = JSON.parse(
              readFileSync(transcriptForBurn, "utf-8")
            );
            writeFileSync(srtPath, whisperToSrt(data), "utf-8");
          }
          await $`ffmpeg -y -i ${assembledVideo} -i ${srtPath} -c:v copy -c:a copy -c:s mov_text ${captionedVideo}`.quiet();
          await $`mv ${captionedVideo} ${assembledVideo}`.quiet();
          console.log(`✅ Fallback: soft subtitles embedded`);
        } catch {
          console.warn(
            `⚠️  All caption methods failed — video without captions`
          );
        }
      }
    }

    ctx.captionsPath = existsSync(fixedJson) ? fixedJson : whisperJson;
    return ctx.captionsPath || "";
  },
};

export default step;
