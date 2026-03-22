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

## Step 4: Deploy Modal Scripts

```bash
cd ~/Project/clawcontent
modal deploy modal/flux_image.py       # Flux image generation
modal deploy modal/lipsync.py          # LTX-2.3 lipsync
modal deploy modal/chatterbox_tts.py   # English TTS (Chatterbox)
modal deploy modal/f5tts_thai.py       # Thai TTS (F5-TTS)
```

First deploy downloads models (slow). Subsequent runs are fast.

If user doesn't have Modal account yet: `modal setup` to authenticate.

## Step 5: Create First Channel

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
    │                   ├─ modal/flux_image.py (Flux image gen)
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
├── pipeline.ts        # Production pipeline orchestrator
├── workflow.ts        # Workflow YAML engine
├── agent.ts           # OpenClaw integration (HTTP API + CLI fallback)
├── research.ts        # Research prompt builders
├── index.html         # Dashboard UI (single file)
├── thumbnail.html     # Playwright thumbnail template
├── modal/             # Modal serverless scripts
│   ├── flux_image.py
│   ├── lipsync.py
│   ├── chatterbox_tts.py
│   └── f5tts_thai.py
├── workflows/         # Pipeline workflow templates (YAML)
│   ├── full-video-thai.yaml
│   └── slideshow.yaml
├── output/            # Generated content (gitignored)
└── data.db            # SQLite database (gitignored)
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
