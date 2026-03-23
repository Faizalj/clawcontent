---
name: clawcontent
description: "Content automation — scan news, generate scripts, produce videos, publish to platforms. Full video production pipeline."
---

# ClawContent — Content Automation

Automate video content production: discover ideas → write scripts → produce videos → publish.

**Requires:** ClawContent server running (`bun run dev` at localhost:3456)

## CLI Commands

**How to run:** `clawcontent <command>`

**Install CLI (one time):**
```bash
cd <clawcontent-repo-path>
bun link
```
This makes `clawcontent` available globally.

**Server must be running:** `cd <clawcontent-repo-path> && bun run dev`

### Discovery — หาข่าว/ไอเดีย

```bash
# List channels
clawcontent channels

# Scan for news/ideas
clawcontent scan <channel-id>

# List discovered ideas
clawcontent ideas <channel-id>
```

### Content — จัดการ content

```bash
# Approve content for script writing
clawcontent approve <content-id>

# Reject content
clawcontent reject <content-id>
```

### Script — เขียน script

```bash
# Generate script via AI agent
clawcontent script <content-id>

# View script text
clawcontent script-view <content-id>

# Approve script for production
clawcontent script-approve <content-id>
```

### Production — สร้าง video

```bash
# Start production pipeline
clawcontent produce <content-id>

# Check pipeline status (all steps + lipsync chunks)
clawcontent status <content-id>

# Stop a running step
clawcontent stop <content-id> <step-name>

# Retry a failed step (resumes from where it stopped)
clawcontent retry <content-id> <step-name>

# Reset pipeline back to script
clawcontent reset <content-id>
```

### Publishing — เผยแพร่

```bash
# Generate SEO metadata (title, description, tags)
clawcontent seo <content-id>

# Publish to platforms
clawcontent publish <content-id>
```

## Typical Workflow

1. `clawcontent scan builder-with-ai` — หาข่าว
2. `clawcontent ideas builder-with-ai` — ดูข่าวที่เจอ
3. `clawcontent approve 5` — เลือกข่าวที่ต้องการ
4. `clawcontent script 5` — ให้ AI เขียน script
5. `clawcontent script-view 5` — ตรวจ script
6. `clawcontent script-approve 5` — อนุมัติ script
7. `clawcontent produce 5` — เริ่มสร้าง video
8. `clawcontent status 5` — ดู progress
9. `clawcontent publish 5` — เผยแพร่

## Pipeline Steps

- **voice** — TTS (ElevenLabs / Chatterbox / F5-TTS)
- **lipsync** — Avatar lipsync (LTX-2.3, chunked with resume)
- **images** — AI images (Z-Image-Turbo, batch)
- **assembly** — Video assembly (ffmpeg overlay)
- **captions** — Captions (Whisper + fix typos + Playwright burn)
- **thumbnail** — Thumbnail (Playwright HTML)

## Notes

- Server must be running: `cd ~/Project/clawcontent && bun run dev`
- All output is JSON — parse with jq if needed
- Pipeline steps run sequentially, lipsync has chunk resume
- Lipsync chunks are saved — retry doesn't re-render completed chunks
