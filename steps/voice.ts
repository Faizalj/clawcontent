import type { PipelineStep, PipelineContext } from "./types";
import {
  loadEnv,
  runModal,
  parseModalOutput,
  stripScriptForTTS,
  writeFileSync,
} from "./helpers";

// ---------------------------------------------------------------------------
// Voice sub-providers
// ---------------------------------------------------------------------------

async function voiceElevenLabs(
  text: string,
  outPath: string,
  env: Record<string, string>
) {
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

async function voiceModal(
  script: string,
  text: string,
  outPath: string,
  referenceAudio?: string
) {
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

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

const step: PipelineStep = {
  name: "voice",
  description: "Generate voice audio via TTS (ElevenLabs, Chatterbox, or F5TTS-Thai)",
  requires: ["scriptText"],
  provides: ["voicePath"],
  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    const ttsProvider =
      ctx.profile?.tts_provider || ctx.channel.tts_provider || "elevenlabs";
    const outPath = `${ctx.outputDir}/voice.mp3`;
    const ttsText = stripScriptForTTS(ctx.scriptText);

    if (ttsProvider === "elevenlabs") {
      await voiceElevenLabs(ttsText, outPath, ctx.env);
    } else if (ttsProvider === "chatterbox") {
      await voiceModal(
        "chatterbox_tts.py",
        ttsText,
        outPath,
        ctx.channel.avatar_url
      );
    } else if (ttsProvider === "f5tts-thai") {
      await voiceModal(
        "f5tts_thai.py",
        ttsText,
        outPath,
        ctx.channel.avatar_url
      );
    } else {
      throw new Error(`Unknown TTS provider: ${ttsProvider}`);
    }

    ctx.voicePath = outPath;
    console.log(`✅ Voice generated (${ttsProvider}): ${outPath}`);
    return outPath;
  },
};

export default step;
