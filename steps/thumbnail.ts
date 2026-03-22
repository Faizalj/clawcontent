import type { PipelineStep, PipelineContext } from "./types";
import { $, writeFileSync, readFileSync, existsSync } from "./helpers";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const step: PipelineStep = {
  name: "thumbnail",
  description: "Generate thumbnail via Playwright HTML screenshot",
  requires: ["channel", "content"],
  provides: [],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    console.log("📸 Generating thumbnail via Playwright...");

    const templatePath = `${import.meta.dir}/../../thumbnail.html`;
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
      .replace(
        /\{\{EP_BADGE\}\}/g,
        ctx.content.ep_number
          ? `<div class="ep-badge">EP ${escapeHtml(ctx.content.ep_number)}</div>`
          : ""
      );

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
        console.warn(
          "⚠️  Playwright not installed — skipping thumbnail. Install: npx playwright install chromium"
        );
        return "";
      }
    }

    console.log(`✅ Thumbnail saved: ${outPath}`);
    return outPath;
  },
};

export default step;
