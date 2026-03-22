# ClawContent — AI Agent Instructions

Content production framework. Pipeline steps are plugins in `steps/` — add-on architecture.

## Project Structure

```
pipeline.ts        — Orchestrator ONLY (don't add step logic here)
steps/             — Pipeline step plugins (main contribution area)
  types.ts         — PipelineStep interface + PipelineContext
  helpers.ts       — Shared: loadEnv, runModal, Whisper, SRT
  index.ts         — Auto-discover loader (don't modify)
  voice.ts         — TTS step
  images.ts        — AI image gen step
  lipsync.ts       — Lipsync step
  assembly.ts      — Video assembly step
  captions.ts      — Caption step
  thumbnail.ts     — Thumbnail step
workflows/         — Production profiles (YAML)
modal/             — Modal GPU scripts (Python)
tools/             — Python caption tools
server.ts          — Bun HTTP server
db.ts              — SQLite
index.html         — Dashboard UI
```

## Rules

1. **Never modify `pipeline.ts`** to add step logic — create a file in `steps/` instead
2. **Never modify `steps/index.ts`** — it auto-discovers steps
3. **Never modify `steps/types.ts`** unless adding a new context field (discuss first)
4. **Every step file** must export default `PipelineStep` with `requires` and `provides`
5. **Use helpers** from `steps/helpers.ts` — don't duplicate loadEnv, runModal, etc.
6. **Output files** go in `ctx.outputDir` — never hardcode paths
7. **API keys** come from `ctx.env` (loaded from DB settings + ~/.env) — never hardcode

## Creating a New Step

```typescript
// steps/my-step.ts
import type { PipelineStep, PipelineContext } from "./types";
import { existsSync, writeFileSync } from "./helpers";

const step: PipelineStep = {
  name: "my-step",
  description: "What this step does",
  requires: ["assembledPath"],       // MUST exist before running
  optionalRequires: ["voicePath"],   // used if available
  provides: ["myOutputField"],       // what this step adds to context

  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    const outPath = `${ctx.outputDir}/my-output.mp4`;
    // ... logic ...
    return outPath;
  },
};

export default step;
```

Drop the file in `steps/` → server restart → step available.

## Context Fields

| Field | Type | Available | Set By |
|-------|------|-----------|--------|
| outputDir | string | always | pipeline |
| scriptText | string | always | pipeline |
| channel | object | always | pipeline |
| content | object | always | pipeline |
| env | Record | always | pipeline |
| profile | WorkflowProfile | always | pipeline |
| voicePath | string\|null | after voice | voice step |
| lipsyncPath | string\|null | after lipsync | lipsync step |
| imagePaths | string[] | after images | images step |
| assembledPath | string\|null | after assembly | assembly step |
| captionsPath | string\|null | after captions | captions step |

## Step Execution Order

Determined by `workflow.ts resolveSteps()` — NOT by file order:
```
voice → lipsync → images → assembly → captions
```

Lipsync is skipped if `use_lipsync: false` in workflow profile.

## Tech Stack

- Runtime: Bun
- DB: SQLite (bun:sqlite)
- GPU: Modal serverless (`modal run`)
- TTS: ElevenLabs API / Chatterbox (Modal) / F5-TTS-THAI (local)
- Images: Z-Image-Turbo (Modal L40S)
- Lipsync: LTX-2.3 (Modal A100-40GB)
- Captions: Whisper (local) + Playwright burn
- Assembly: ffmpeg (local)
- Agent: OpenClaw Gateway (HTTP API + CLI fallback)

## Common Tasks

**Add a new pipeline step:** Create `steps/xxx.ts`, export PipelineStep
**Add a workflow profile:** Create `workflows/xxx.yaml`
**Add a Modal GPU script:** Create `modal/xxx.py` with `@app.local_entrypoint()`
**Run server:** `bun run dev`
**Build check:** `bun build server.ts --no-bundle`
