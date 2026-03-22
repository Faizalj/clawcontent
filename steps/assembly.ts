import type { PipelineStep, PipelineContext } from "./types";
import { $, writeFileSync, existsSync } from "./helpers";

const step: PipelineStep = {
  name: "assembly",
  description: "Assemble final video with ffmpeg (lipsync overlay or slideshow)",
  requires: ["voicePath"],
  optionalRequires: ["lipsyncPath", "imagePaths"],
  provides: ["assembledPath"],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    const outPath = `${ctx.outputDir}/final.mp4`;
    const hasLipsync =
      ctx.lipsyncPath &&
      ctx.lipsyncPath.length > 0 &&
      existsSync(ctx.lipsyncPath);
    const hasImages =
      ctx.imagePaths.length > 0 && ctx.imagePaths.every((p) => existsSync(p));

    if (hasLipsync && hasImages) {
      // Lipsync = main video (audio + lip sync), images = overlay inserts
      // Audio stays continuous from lipsync — lips stay in sync
      console.log(
        "🎬 Assembling: lipsync (main) + image inserts (overlay)..."
      );

      // Get lipsync duration
      const lipDurStr =
        await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${ctx.lipsyncPath}`.text();
      const lipDur = parseFloat(lipDurStr.trim());

      // Scale lipsync to 1280x720 if needed
      const scaledLip = `${ctx.outputDir}/lipsync_scaled.mp4`;
      const scaleFilter =
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1";
      const cp = require("child_process");
      cp.execFileSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          ctx.lipsyncPath!,
          "-vf",
          scaleFilter,
          "-c:a",
          "copy",
          scaledLip,
        ],
        { stdio: "pipe" }
      );

      // Create insert clips (5s each, scaled to 1280x720)
      const insertClips: string[] = [];
      for (let i = 0; i < ctx.imagePaths.length; i++) {
        const clipPath = `${ctx.outputDir}/insert_${i}.mp4`;
        cp.execFileSync(
          "ffmpeg",
          [
            "-y",
            "-loop",
            "1",
            "-i",
            ctx.imagePaths[i],
            "-c:v",
            "libx264",
            "-t",
            "5",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            scaleFilter,
            "-r",
            "25",
            clipPath,
          ],
          { stdio: "pipe" }
        );
        insertClips.push(clipPath);
      }

      // Calculate overlay timestamps — distribute inserts evenly across video
      // Leave first 10s and last 10s as pure lipsync
      const insertDur = 5;
      const usableDur = lipDur - 20;
      const interval = usableDur / (insertClips.length + 1);

      // Build ffmpeg overlay filter — each insert overlays at its timestamp
      // Audio from lipsync stays continuous (no shift)
      let filterParts: string[] = [];
      let lastOutput = "0:v";

      for (let i = 0; i < insertClips.length; i++) {
        const startTime = Math.round(10 + interval * (i + 1));
        const endTime = startTime + insertDur;
        const inputIdx = i + 1;
        const outLabel = i === insertClips.length - 1 ? "vout" : `v${i}`;

        filterParts.push(
          `[${inputIdx}:v]setpts=PTS-STARTPTS[ins${i}]`
        );
        filterParts.push(
          `[${lastOutput}][ins${i}]overlay=enable='between(t,${startTime},${endTime})'[${outLabel}]`
        );
        lastOutput = outLabel;

        console.log(`  📎 Insert ${i}: ${startTime}s-${endTime}s`);
      }

      // Write filter to file to avoid shell escaping issues
      const filterFile = `${ctx.outputDir}/overlay_filter.txt`;
      writeFileSync(filterFile, filterParts.join(";\n"), "utf-8");

      // Build ffmpeg args array
      const args = ["-y", "-i", scaledLip];
      for (const clip of insertClips) {
        args.push("-i", clip);
      }
      args.push(
        "-filter_complex_script",
        filterFile,
        "-map",
        "[vout]",
        "-map",
        "0:a",
        "-c:a",
        "copy",
        "-shortest",
        outPath
      );

      cp.execFileSync("ffmpeg", args, { stdio: "pipe" });

      console.log(`✅ ${insertClips.length} inserts overlaid on lipsync`);
    } else if (hasLipsync) {
      // Lipsync only, no inserts
      console.log("🎬 Assembling: lipsync video only...");
      await $`cp ${ctx.lipsyncPath} ${outPath}`.quiet();
    } else if (hasImages && ctx.voicePath) {
      // No lipsync — slideshow from images + voice
      // Calculate duration per image to match voice length
      const durStr =
        await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${ctx.voicePath}`.text();
      const voiceDur = parseFloat(durStr.trim());
      const durPerImage = Math.ceil(voiceDur / ctx.imagePaths.length);
      console.log(
        `🎬 Assembling: slideshow (${ctx.imagePaths.length} images × ${durPerImage}s = ${voiceDur.toFixed(0)}s) + voice...`
      );

      const concatPath = `${ctx.outputDir}/images.txt`;
      const concatContent =
        ctx.imagePaths
          .map((p) => `file '${p}'\nduration ${durPerImage}`)
          .join("\n") +
        `\nfile '${ctx.imagePaths[ctx.imagePaths.length - 1]}'`;
      writeFileSync(concatPath, concatContent, "utf-8");

      const slideshowPath = `${ctx.outputDir}/slideshow.mp4`;
      await $`ffmpeg -y -f concat -safe 0 -i ${concatPath} -vsync vfr -pix_fmt yuv420p ${slideshowPath}`.quiet();

      await $`ffmpeg -y -i ${slideshowPath} -i ${ctx.voicePath} -c:v copy -c:a aac -shortest ${outPath}`.quiet();
    } else {
      throw new Error(
        "Assembly requires lipsync video or images + voice audio"
      );
    }

    console.log(`✅ Video assembled: ${outPath}`);
    return outPath;
  },
};

export default step;
