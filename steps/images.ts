import type { PipelineStep, PipelineContext } from "./types";
import {
  runModal,
  parseModalOutput,
  extractAllImagePrompts,
  parseScriptSections,
  buildVisualPrompt,
  existsSync,
} from "./helpers";

const step: PipelineStep = {
  name: "images",
  description: "Generate images via Z-Image-Turbo batch on Modal",
  requires: ["scriptText"],
  provides: ["imagePaths"],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    // Determine aspect ratio from orientation
    const orientation = ctx.profile?.orientation || "landscape";
    const aspectRatio = orientation === "portrait" ? "9:16 vertical" : orientation === "square" ? "1:1 square" : "16:9";
    const imageStyle =
      ctx.profile?.image_style ||
      `professional digital illustration, modern, clean, vibrant colors, ${aspectRatio}`;

    // Extract ALL <!-- image: --> prompts from script (not just per section)
    const embeddedPrompts = extractAllImagePrompts(ctx.scriptText);

    let batch: { prompt: string; path: string }[];

    if (embeddedPrompts.length > 0) {
      // Use embedded prompts from script (agent wrote them every 2-3 sentences)
      batch = embeddedPrompts.map((p, i) => ({
        prompt: `${imageStyle}. ${p}`,
        path: `${ctx.outputDir}/img_${i}.jpeg`,
      }));
    } else {
      // Fallback: generate from sections (old behavior)
      const sections = parseScriptSections(ctx.scriptText);
      if (sections.length === 0) {
        throw new Error("No sections or image prompts found in script");
      }
      batch = sections.map((section, i) => ({
        prompt: buildVisualPrompt(section, ctx.channel.name, imageStyle),
        path: `${ctx.outputDir}/img_${i}.jpeg`,
      }));
    }

    console.log(
      `🖼️  Generating ${batch.length} images in one batch via Z-Image-Turbo...`
    );

    // Send all prompts in one Modal run — boot once, gen all
    const batchJson = JSON.stringify(batch).replace(/'/g, "'\\''");
    const stdout = await runModal("flux_image.py", {
      "prompts-json": `'${batchJson}'`,
    });

    const result = parseModalOutput(stdout);
    const paths = batch.map((b) => b.path).filter((p) => existsSync(p));

    if (paths.length === 0) {
      throw new Error(`Image gen failed: ${JSON.stringify(result)}`);
    }

    console.log(`✅ ${paths.length}/${batch.length} images generated`);
    ctx.imagePaths = paths;
    return JSON.stringify(paths);
  },
};

export default step;
