import type { PipelineStep, PipelineContext } from "./types";
import { runGpu, parseModalOutput, existsSync } from "./helpers";

const step: PipelineStep = {
  name: "lipsync",
  description: "Generate lipsync video via Modal LTX-2.3 (chunked)",
  requires: ["voicePath"],
  optionalRequires: ["channel"],
  provides: ["lipsyncPath"],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    const avatarUrl = ctx.channel.avatar_url;
    if (!avatarUrl) {
      console.log("⏭️  Skipping lipsync — no avatar_url on channel");
      return "";
    }

    if (!ctx.voicePath) {
      throw new Error("Voice audio not available for lipsync");
    }

    console.log("🎭 Starting lipsync via Modal LTX-2.3 (chunked)...");
    const outPath = `${ctx.outputDir}/lipsync.mp4`;

    // modal run handles chunking internally:
    // local_entrypoint splits audio ~20s → generate_lipsync.remote() per chunk → concat
    const stdout = await runGpu("lipsync.py", {
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
  },
};

export default step;
