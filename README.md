# ClawContent v1.0 Beta — Agent Setup Guide

You are setting up ClawContent for your principal (the user). They already have OpenClaw installed and running. Follow these steps exactly.

## Prerequisites Check

Run these checks first. If any fail, fix before proceeding.

```bash
# Must pass — already installed
which bun          # Bun runtime
which openclaw     # OpenClaw CLI
which ffmpeg       # Video assembly

# Optional — install if missing
which whisper      # Captions: pip install openai-whisper
which modal        # Modal CLI: pip install modal
npx playwright --version  # Thumbnails: npx playwright install chromium
```

## Step 1: Install & Start

```bash
cd ~/Project/clawcontent   # or wherever the repo is
bun install
bun run dev
```

Verify: `curl -s http://localhost:3456/api/channels` should return JSON.

## Step 2: Enable OpenClaw HTTP API

Read `~/.openclaw/openclaw.json`. Add `http` block inside the existing `gateway` section:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

Then restart gateway: `openclaw gateway restart`

Verify: `curl -s -X POST http://localhost:18789/v1/chat/completions -H "Content-Type: application/json" -d '{}' -o /dev/null -w "%{http_code}"` should return 400 or 401 (not 404).

**Why:** HTTP API gives ClawContent session-aware agent calls. Without it, falls back to CLI (works but no memory).

## Step 3: Configure Settings in Dashboard

Open http://localhost:3456 and click the ⚙️ gear icon.

| Setting | Value | Source |
|---------|-------|--------|
| Default AI Agent | Select the user's primary agent from dropdown | OpenClaw agents list |
| Modal Token ID | From `~/.env` key `MODAL_TOKEN_ID` or ask user | modal.com/settings |
| Modal Token Secret | From `~/.env` key `MODAL_TOKEN_SECRET` or ask user | modal.com/settings |
| ElevenLabs API Key | From `~/.env` key `ELEVENLABS_API_KEY` (optional) | elevenlabs.io |

If keys exist in `~/.env`, the system reads them automatically — no need to re-enter.

## Step 4: Setup Modal CLI

Modal scripts run on-demand via `modal run` — no deployment step needed.
The system calls Modal automatically when production pipeline runs.
First run downloads models (slow). Subsequent runs use cached models.

```bash
# Install Modal CLI (if not installed)
pip install modal

# Authenticate (one time)
modal setup
```

Verify: `modal profile list` should show your workspace.

## Step 6: Create First Channel

In dashboard, click "+ Add Channel":

- **Channel ID:** lowercase-english-no-spaces (e.g. `ai-cooking`)
- **Channel Name:** Display name (e.g. `AI Cooking Thai`)
- **Description:** Channel concept and target audience
- **OpenClaw Agent:** Select agent (or leave empty to use Default Agent)
- **TTS Provider:** `elevenlabs` for Thai, `chatterbox` for English, `f5tts-thai` for free Thai
- **Workflow:** `full-video-thai` for full production, `slideshow` for image+voice only
- **Avatar URL:** Real photo URL if using lipsync step

## Architecture

```
Dashboard (Bun + SQLite, port 3456)
    │
    ├─ AI Features ──→ OpenClaw Gateway (HTTP API, port 18789)
    │                   ├─ Scan news
    │                   ├─ Generate script
    │                   └─ AI brief → workflow
    │
    ├─ Production ───→ Modal Serverless (GPU)
    │                   ├─ modal/flux_image.py (Z-Image-Turbo image gen)
    │                   ├─ modal/lipsync.py (LTX-2.3)
    │                   ├─ modal/chatterbox_tts.py (English TTS)
    │                   └─ modal/f5tts_thai.py (Thai TTS)
    │
    └─ Local Tools ──→ ffmpeg (assembly), Whisper (captions), Playwright (thumbnail)
```

## File Structure

```
clawcontent/
├── server.ts          # Bun HTTP server + API routes
├── db.ts              # SQLite schema + queries
├── pipeline.ts        # Pipeline orchestrator (170 lines, no step logic)
├── workflow.ts        # Workflow profile engine
├── agent.ts           # OpenClaw integration (HTTP API + CLI fallback)
├── research.ts        # Research prompt builders
├── index.html         # Dashboard UI (single file)
├── thumbnail.html     # Playwright thumbnail template
├── steps/             # Pipeline step plugins (add-on architecture)
│   ├── index.ts       # Auto-discover step loader
│   ├── types.ts       # PipelineStep interface (requires/provides contract)
│   ├── helpers.ts     # Shared helpers (Modal, Whisper, SRT, env)
│   ├── voice.ts       # TTS (ElevenLabs/Chatterbox/F5TTS)
│   ├── images.ts      # AI images (Z-Image-Turbo batch)
│   ├── lipsync.ts     # Lipsync (Modal LTX-2.3 chunked)
│   ├── assembly.ts    # Video assembly (ffmpeg overlay)
│   ├── captions.ts    # Captions (Whisper + fix typos + Playwright burn)
│   └── thumbnail.ts   # Thumbnail (Playwright HTML)
├── tools/             # Python caption tools (project copy)
│   ├── animated_caption.py
│   └── fix_caption_typos.py
├── modal/             # Modal serverless GPU scripts
│   ├── flux_image.py
│   ├── lipsync.py
│   ├── chatterbox_tts.py
│   └── f5tts_thai.py
├── workflows/         # Pipeline workflow profiles (YAML)
│   └── full-video-thai.yaml
├── channels/          # Per-channel assets (avatar, etc.) (gitignored)
├── output/            # Generated content (gitignored)
└── data.db            # SQLite database (gitignored)
```

## Contributing Pipeline Steps

ClawContent uses a **plugin architecture** for pipeline steps. Each step is an independent file in `steps/` that the engine auto-discovers.

### Creating a New Step

1. Create `steps/your-step.ts`:

```typescript
import type { PipelineStep, PipelineContext } from "./types";

const step: PipelineStep = {
  name: "your-step",
  description: "What this step does",

  // Contract: what context fields are needed and what this step produces
  requires: ["voicePath"],           // MUST exist before this step runs
  optionalRequires: ["lipsyncPath"], // Used if available
  provides: ["yourOutputField"],     // What this step adds to context

  async execute(contentId: number, ctx: PipelineContext): Promise<string> {
    // Your step logic here
    // Access ctx.voicePath, ctx.env, ctx.channel, etc.
    // Return output file path
    const outPath = `${ctx.outputDir}/your-output.mp4`;
    // ... do work ...
    return outPath;
  },
};

export default step;
```

2. Add step name to workflow YAML:

```yaml
# workflows/full-video-thai.yaml
steps:  # resolveSteps() determines order from profile config
```

3. Done — step auto-loads on server start.

### Step Contract (requires/provides)

Each step declares what it needs and what it produces:

| Step | Requires | Provides |
|------|----------|----------|
| voice | scriptText | voicePath |
| lipsync | voicePath | lipsyncPath |
| images | scriptText | imagePaths |
| assembly | voicePath + (lipsyncPath or imagePaths) | assembledPath |
| captions | scriptText, assembledPath | captionsPath |
| thumbnail | channel, content | — |

Pipeline engine validates requirements before running each step. If a required field is missing, the step fails with a clear error.

### Available Helpers

Import from `./helpers`:

```typescript
// Modal GPU
runModal(script, args)         // Run Modal script, return stdout
parseModalOutput(stdout)       // Parse JSON from Modal output

// Environment
loadEnv()                      // Read API keys from DB + ~/.env

// Script parsing
stripScriptForTTS(markdown)    // Clean script for TTS
parseScriptSections(text)      // Split by ## [timecode] headers
extractAllImagePrompts(text)   // Extract all <!-- image: --> prompts

// SRT/Captions
whisperToSrt(data)             // Convert Whisper JSON to SRT
buildSrt(sentences)            // Build SRT from sentence list
```

## Content Pipeline Flow

```
discovered → approved → scripted → script_approved → producing → done
```

Each transition is triggered by user action in dashboard or API call.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/channels | List channels with content counts |
| POST | /api/channels/save | Create/update channel |
| DELETE | /api/channels/:id | Delete channel + cascade |
| GET | /api/content?channel=X&status=Y | List content |
| POST | /api/content/add | Add manual content |
| POST | /api/content/:id/approve | Approve content |
| POST | /api/content/:id/reject | Reject content |
| POST | /api/scan/:channel | Trigger news scan via agent |
| GET | /api/script/:id | Get script for content |
| POST | /api/script/:id/generate | Generate script via agent |
| POST | /api/script/:id/approve | Approve script |
| POST | /api/production/:id/start | Start production pipeline |
| GET | /api/production/:id | Get pipeline step status |
| POST | /api/production/:id/retry/:step | Retry failed step |
| GET | /api/workflows | List all workflows |
| POST | /api/workflows | Save workflow (YAML) |
| DELETE | /api/workflows/:id | Delete custom workflow |
| POST | /api/workflows/generate | Brief → YAML via agent |
| GET | /api/settings | Get settings (masked values) |
| POST | /api/settings | Save settings |
| GET | /api/agents | List OpenClaw agents |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No AI agent configured" | No Default Agent in Settings | Settings ⚙️ → select Default AI Agent |
| "Gateway error" / connection refused | OpenClaw gateway not running | `openclaw gateway start` |
| Scan returns error | Agent not assigned to channel | Edit channel → select agent, or set Default Agent |
| Modal timeout on first run | Cold start (downloading models) | Wait 2-3 min, will be fast after first run |
| Thumbnail empty | Playwright not installed | `npx playwright install chromium` |
| Captions timing wrong | Whisper not installed, using fallback | `pip install openai-whisper` |
| 404 on HTTP API | chatCompletions not enabled | Add http.endpoints config to openclaw.json |
