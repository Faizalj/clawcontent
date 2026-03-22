# Contributing to ClawContent

ClawContent is a content production **framework** — we welcome contributions, especially new pipeline steps and workflow profiles.

## What You Can Contribute

| Area | Directory | Welcome? |
|------|-----------|----------|
| **Pipeline Steps** | `steps/` | Yes — this is the main contribution area |
| **Workflow Profiles** | `workflows/` | Yes — new production profiles |
| **Modal Scripts** | `modal/` | Yes — new GPU compute scripts |
| **Caption Tools** | `tools/` | Yes — improved caption processing |
| **Bug Fixes** | anywhere | Yes |
| **Core Framework** | `pipeline.ts`, `server.ts`, `db.ts` | **No** — discuss in issue first |
| **Dashboard UI** | `index.html` | **No** — discuss in issue first |

## Contributing Pipeline Steps

This is the **primary contribution area**. Each step is an independent plugin.

### Step 1: Create Your Step File

Create `steps/your-step.ts`:

```typescript
import type { PipelineStep, PipelineContext } from "./types";
import { existsSync, writeFileSync } from "./helpers";

const step: PipelineStep = {
  name: "your-step",
  description: "What this step does",
  requires: ["assembledPath"],     // Context fields needed
  optionalRequires: [],            // Nice to have
  provides: ["yourOutputField"],   // What you add to context

  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    const outPath = `${ctx.outputDir}/your-output.mp4`;
    // ... your logic ...
    return outPath;
  },
};

export default step;
```

### Step 2: Test Locally

```bash
bun run dev
# Check server logs — your step should appear in:
# 📦 Loaded N pipeline steps: ..., your-step
```

### Step 3: Submit PR

- PR title: `step: your-step-name`
- Include only files in `steps/` (and `modal/` if needed)
- Do NOT modify `pipeline.ts`, `server.ts`, `db.ts`, `index.html`

## Step Contract Rules

Every step MUST declare:

```typescript
requires: [...]    // What MUST exist in context before running
provides: [...]    // What this step adds to context
```

### Available Context Fields

| Field | Type | Set By |
|-------|------|--------|
| `outputDir` | string | pipeline (always available) |
| `scriptText` | string | pipeline (always available) |
| `channel` | object | pipeline (always available) |
| `content` | object | pipeline (always available) |
| `env` | object | pipeline (always available) |
| `profile` | object | pipeline (always available) |
| `voicePath` | string | voice step |
| `lipsyncPath` | string | lipsync step |
| `imagePaths` | string[] | images step |
| `assembledPath` | string | assembly step |
| `captionsPath` | string | captions step |

### Rules

1. **Never modify other step's output files** — read only
2. **Always return output path** from execute()
3. **Handle errors gracefully** — throw with clear message
4. **Don't hardcode paths** — use `ctx.outputDir` and helpers
5. **Don't import from pipeline.ts** — only from `./types` and `./helpers`
6. **Declare all requirements** — pipeline validates before running

## Contributing Workflow Profiles

Create `workflows/your-profile.yaml`:

```yaml
name: Your Profile Name
description: "What this profile is for"

language: th
video_duration: 3-4min
script_format: 4-section

tts_provider: elevenlabs
tts_voice_id: ""
image_style: "your style description"
use_lipsync: false

thumbnail_style: gradient
image_negative: "text, watermark"
script_instruction: ""
```

### Rules

1. File must have `.yaml` extension
2. Files starting with `_` are hidden (disabled)
3. Must have `name` and `steps` or config fields
4. Test that the workflow runs end-to-end before PR

## Contributing Modal Scripts

Create `modal/your-script.py`:

### Rules

1. Must have `@app.local_entrypoint()` for CLI testing
2. Must print JSON as last line: `{"status": "completed", ...}`
3. Include deploy/test instructions in comment header
4. Specify GPU type and estimated cost

## PR Guidelines

1. **One feature per PR** — don't bundle unrelated changes
2. **Test before submitting** — run the full pipeline with your change
3. **Don't modify core files** — `pipeline.ts`, `server.ts`, `db.ts`, `index.html` require discussion
4. **Thai + English OK** — comments and docs in either language
5. **No API keys or secrets** — ever
