import {
  getChannels,
  getChannel,
  getContent,
  getContentById,
  addContent,
  updateContentStatus,
  getScript,
  addScript,
  approveScript,
  getContentCounts,
  upsertChannel,
  deleteChannel,
  getPipelineJobs,
  deletePipelineJobs,
  updatePipelineJob,
  getAllSettings,
  setSetting,
  setScanStatus,
  getScanStatus,
  setTaskStatus,
  getTaskStatus,
} from "./db";
import { sendToAgent, parseAgentJson, getAgentList } from "./agent";
import { buildResearchPrompt, buildScriptPrompt } from "./research";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { startPipeline, retryStep, loadEnv } from "./pipeline";
import { getWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, resolveSteps } from "./workflow";
import { getSetting } from "./db";

function resolveAgentId(channelAgentId?: string): string | null {
  return channelAgentId || getSetting("DEFAULT_AGENT_ID") || null;
}
import index from "./index.html";

const PORT = 3456;

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
  },
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- API Routes ---

    // GET /api/channels
    if (path === "/api/channels" && req.method === "GET") {
      const channels = getChannels() as any[];
      // Add counts to each channel
      const result = channels.map((ch) => ({
        ...ch,
        pipeline_steps: JSON.parse(ch.pipeline_steps || "[]"),
        counts: getContentCounts(ch.id),
      }));
      return Response.json(result);
    }

    // GET /api/agents — list available OpenClaw agents
    if (path === "/api/agents" && req.method === "GET") {
      return Response.json(getAgentList());
    }

    // GET /api/content?channel=X&status=Y
    if (path === "/api/content" && req.method === "GET") {
      const channel = url.searchParams.get("channel") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const items = getContent(channel, status);
      return Response.json(items);
    }

    // POST /api/content/:id/approve
    const approveMatch = path.match(/^\/api\/content\/(\d+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      const id = parseInt(approveMatch[1]);
      updateContentStatus(id, "approved");
      return Response.json({ ok: true });
    }

    // POST /api/content/:id/reject
    const rejectMatch = path.match(/^\/api\/content\/(\d+)\/reject$/);
    if (rejectMatch && req.method === "POST") {
      const id = parseInt(rejectMatch[1]);
      updateContentStatus(id, "rejected");
      return Response.json({ ok: true });
    }

    // POST /api/scan/:channel — trigger agent research
    const scanMatch = path.match(/^\/api\/scan\/(.+)$/);
    if (scanMatch && req.method === "POST") {
      const channelId = scanMatch[1];
      const channel = getChannel(channelId) as any;
      if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });

      const prompt = buildResearchPrompt(channel);
      const agentId = resolveAgentId(channel.agent_id);
      if (!agentId) return Response.json({ error: "No AI agent configured. Set Default Agent in Settings or assign agent to channel." }, { status: 400 });

      setScanStatus(channelId, "scanning", `Scanning via agent ${agentId}...`);

      // Run in background
      (async () => {
        console.log(`🔍 Scanning for ${channel.name} via agent ${agentId}...`);
        const response = await sendToAgent(agentId, prompt, 180);

        if (response.success) {
          console.log(`📨 Agent raw response (first 500 chars):`, response.message.slice(0, 500));
          const items = parseAgentJson(response.message);
          console.log(`📋 Parsed ${items.length} items from response`);
          let added = 0;
          for (const item of items) {
            if (item.title) {
              addContent({
                channel_id: channelId,
                type: channel.research_type || "news",
                title: item.title,
                summary: item.summary || "",
                source_url: item.source_url || "",
                source_data: JSON.stringify(item),
              });
              added++;
            }
          }
          console.log(`✅ Added ${added} items for ${channel.name}`);
          setScanStatus(channelId, "done", `Found ${added} items`);
        } else {
          console.error(`❌ Agent failed:`, response.message);
          setScanStatus(channelId, "error", response.message);
        }
      })();

      return Response.json({ ok: true, message: `Scanning started for ${channel.name}` });
    }

    // GET /api/script/:content_id
    const scriptGetMatch = path.match(/^\/api\/script\/(\d+)$/);
    if (scriptGetMatch && req.method === "GET") {
      const contentId = parseInt(scriptGetMatch[1]);
      const script = getScript(contentId);
      return Response.json(script || { error: "No script yet" });
    }

    // POST /api/script/:content_id/generate — trigger script generation
    const scriptGenMatch = path.match(/^\/api\/script\/(\d+)\/generate$/);
    if (scriptGenMatch && req.method === "POST") {
      const contentId = parseInt(scriptGenMatch[1]);
      const content = getContentById(contentId) as any;
      if (!content) return Response.json({ error: "Content not found" }, { status: 404 });

      const channel = getChannel(content.channel_id) as any;
      if (!channel) return Response.json({ error: "Channel not found" }, { status: 404 });

      const agentId = resolveAgentId(channel.agent_id);
      if (!agentId) return Response.json({ error: "No AI agent configured. Set Default Agent in Settings or assign agent to channel." }, { status: 400 });
      // Pass workflow profile options to script prompt
      const wf = channel.workflow_id ? getWorkflow(channel.workflow_id) : null;
      const prompt = buildScriptPrompt(channel, content, {
        video_duration: wf?.video_duration,
        script_format: wf?.script_format,
        script_instruction: wf?.script_instruction,
      });

      setTaskStatus(`script:${contentId}`, "generating", `Generating via agent ${agentId}...`);

      // Run in background
      (async () => {
        console.log(`✍️ Generating script for: ${content.title}...`);
        const response = await sendToAgent(agentId, prompt, 180);

        if (response.success) {
          addScript(contentId, response.message, agentId);
          console.log(`✅ Script generated for: ${content.title}`);
          setTaskStatus(`script:${contentId}`, "done", "Script generated");
        } else {
          console.error(`❌ Script gen failed:`, response.message);
          setTaskStatus(`script:${contentId}`, "error", response.message);
        }
      })();

      return Response.json({ ok: true, message: "Script generation started" });
    }

    // POST /api/script/:content_id/approve
    const scriptApproveMatch = path.match(/^\/api\/script\/(\d+)\/approve$/);
    if (scriptApproveMatch && req.method === "POST") {
      const contentId = parseInt(scriptApproveMatch[1]);
      approveScript(contentId);
      return Response.json({ ok: true });
    }

    // POST /api/content/add — manually add content
    if (path === "/api/content/add" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        const id = addContent(body);
        return Response.json({ ok: true, id });
      })();
    }

    // POST /api/channels/save — create or update channel
    if (path === "/api/channels/save" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        upsertChannel({
          id: body.id,
          name: body.name,
          description: body.description,
          agent_id: body.agent_id,
          research_type: body.research_type,
          pipeline_steps: body.pipeline_steps,
          accent_color: body.accent_color,
          avatar_url: body.avatar_url,
          tts_provider: body.tts_provider,
          workflow_id: body.workflow_id,
        });
        return Response.json({ ok: true });
      })();
    }

    // GET /api/scan-status/:channel — poll scan progress
    const scanStatusMatch = path.match(/^\/api\/scan-status\/(.+)$/);
    if (scanStatusMatch && req.method === "GET") {
      const status = getScanStatus(scanStatusMatch[1]);
      return Response.json(status || { status: "idle", message: "" });
    }

    // GET /api/task-status/:key — poll any task progress
    const taskStatusMatch = path.match(/^\/api\/task-status\/(.+)$/);
    if (taskStatusMatch && req.method === "GET") {
      const status = getTaskStatus(decodeURIComponent(taskStatusMatch[1]));
      return Response.json(status || { status: "idle", message: "" });
    }

    // GET /api/lipsync-chunks/:content_id — chunk progress
    const chunksMatch = path.match(/^\/api\/lipsync-chunks\/(\d+)$/);
    if (chunksMatch && req.method === "GET") {
      const contentId = parseInt(chunksMatch[1]);
      const content = getContentById(contentId) as any;
      if (!content) return Response.json({ chunks: [], total: 0 });

      const chunksDir = `${import.meta.dir}/output/${content.channel_id}/${contentId}/lipsync_chunks`;

      if (!existsSync(chunksDir)) return Response.json({ chunks: [], total: 0 });

      const voicePath = `${import.meta.dir}/output/${content.channel_id}/${contentId}/voice.mp3`;
      let total = 0;
      if (existsSync(voicePath)) {
        try {
          const durStr = require("child_process").execSync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${voicePath}"`
          ).toString().trim();
          total = Math.ceil(parseFloat(durStr) / 20);
        } catch {}
      }

      const { readdirSync, statSync } = require("fs");
      const files = readdirSync(chunksDir).filter((f: string) => f.endsWith(".mp4"));
      const done = files.filter((f: string) => {
        try { return statSync(`${chunksDir}/${f}`).size > 50000; } catch { return false; }
      });

      return Response.json({ total, done: done.length, chunks: done.sort() });
    }

    // --- Publishing ---

    // POST /api/publish/:id/seo — generate SEO via agent
    const seoMatch = path.match(/^\/api\/publish\/(\d+)\/seo$/);
    if (seoMatch && req.method === "POST") {
      const contentId = parseInt(seoMatch[1]);
      const content = getContentById(contentId) as any;
      if (!content) return Response.json({ error: "Content not found" }, { status: 404 });

      const channel = getChannel(content.channel_id) as any;
      const agentId = resolveAgentId(channel?.agent_id);

      return (async () => {
      if (agentId) {
        const prompt = `สร้าง SEO metadata สำหรับ YouTube video:
หัวข้อ: ${content.title}
สรุป: ${content.summary}
ช่อง: ${channel?.name}

ตอบเป็น JSON:
{"title": "หัวข้อที่ดึงดูด SEO friendly ไม่เกิน 60 ตัวอักษร", "description": "คำอธิบายดึงดูด SEO friendly 2-3 ย่อหน้า", "tags": "tag1, tag2, tag3, ..."}

ตอบ JSON เท่านั้น`;

        const response = await sendToAgent(agentId, prompt, 30);
        if (response.success) {
          try {
            const jsonMatch = response.message.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              return Response.json(JSON.parse(jsonMatch[0]));
            }
          } catch {}
        }
      }

      // Fallback: generate from content data
      return Response.json({
        title: content.title,
        description: content.summary || "",
        tags: "AI, เทคโนโลยี, ธุรกิจ",
      });
      })();
    }

    // POST /api/publish/:id/thumbnail — generate thumbnail
    const thumbMatch = path.match(/^\/api\/publish\/(\d+)\/thumbnail$/);
    if (thumbMatch && req.method === "POST") {
      const contentId = parseInt(thumbMatch[1]);
      const content = getContentById(contentId) as any;
      if (!content) return Response.json({ error: "Content not found" }, { status: 404 });

      const channel = getChannel(content.channel_id) as any;
      const templatePath = `${import.meta.dir}/thumbnail.html`;
      const outDir = `${import.meta.dir}/output/${content.channel_id}/${contentId}`;

      if (existsSync(templatePath)) {
        try {
          let html = readFileSync(templatePath, "utf-8");
          const accent = channel?.accent_color || "#FF6600";
          html = html
            .replace(/\{\{CHANNEL\}\}/g, channel?.name || "")
            .replace(/\{\{TITLE\}\}/g, content.title)
            .replace(/\{\{ACCENT\}\}/g, accent)
            .replace(/\{\{BG_FROM\}\}/g, "#1a1a2e")
            .replace(/\{\{BG_TO\}\}/g, accent + "88")
            .replace(/\{\{EP_BADGE\}\}/g, "");

          const tempHtml = `${outDir}/thumbnail_temp.html`;
          const outPath = `${outDir}/thumbnail.png`;
          writeFileSync(tempHtml, html, "utf-8");

          const cp = require("child_process");
          cp.execFileSync("npx", ["playwright", "screenshot", "--viewport-size", "1280,720", `file://${tempHtml}`, outPath], { stdio: "pipe", timeout: 30000 });

          return Response.json({ ok: true, path: outPath });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }
      return Response.json({ error: "Template not found" }, { status: 404 });
    }

    // POST /api/publish/:id — publish to platforms
    const publishMatch = path.match(/^\/api\/publish\/(\d+)$/);
    if (publishMatch && req.method === "POST") {
      return (async () => {
        const contentId = parseInt(publishMatch[1]);
        const body = await req.json();

        // TODO: implement actual upload to YouTube/TikTok/Reels
        // For now: mark as published
        updateContentStatus(contentId, "published");

        return Response.json({
          ok: true,
          message: `Published! Platforms: ${body.platforms?.join(", ") || "none"} (auto-upload coming soon)`,
        });
      })();
    }

    // GET /api/publish/:id/download/:type — download files
    const downloadMatch = path.match(/^\/api\/publish\/(\d+)\/download\/(.+)$/);
    if (downloadMatch && req.method === "GET") {
      const contentId = parseInt(downloadMatch[1]);
      const type = downloadMatch[2];
      const content = getContentById(contentId) as any;
      if (!content) return new Response("Not found", { status: 404 });

      const outDir = `${import.meta.dir}/output/${content.channel_id}/${contentId}`;
      const fileMap: Record<string, string> = {
        video: `${outDir}/final.mp4`,
        thumbnail: `${outDir}/thumbnail.png`,
        srt: `${outDir}/captions_fixed.json`,
      };

      const filePath = fileMap[type];
      if (!filePath || !existsSync(filePath)) {
        return new Response("File not found", { status: 404 });
      }

      const file = Bun.file(filePath);
      return new Response(file, {
        headers: {
          "Content-Disposition": `attachment; filename="${type}_${contentId}.${filePath.split(".").pop()}"`,
        },
      });
    }

    // --- Settings ---

    // GET /api/settings — return settings with masked values
    if (path === "/api/settings" && req.method === "GET") {
      const KNOWN_KEYS = ["DEFAULT_AGENT_ID", "ELEVENLABS_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
      const settings = getAllSettings();
      const env = loadEnv();

      const result = KNOWN_KEYS.map((key) => {
        const dbVal = settings.find((s) => s.key === key);
        const val = dbVal?.value || env[key] || "";
        const source = dbVal?.value ? "dashboard" : env[key] ? "env-file" : "not-set";
        return {
          key,
          masked: val ? val.slice(0, 4) + "****" + val.slice(-4) : "",
          source,
          updated_at: dbVal?.updated_at || null,
        };
      });
      return Response.json(result);
    }

    // POST /api/settings — save settings
    if (path === "/api/settings" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        const entries = body.settings as { key: string; value: string }[];
        if (!Array.isArray(entries)) {
          return Response.json({ error: "Invalid payload" }, { status: 400 });
        }
        const ALLOWED_KEYS = ["DEFAULT_AGENT_ID", "ELEVENLABS_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
        for (const entry of entries) {
          if (!ALLOWED_KEYS.includes(entry.key)) continue;
          if (entry.value && entry.value.trim()) {
            setSetting(entry.key, entry.value.trim());
          }
        }
        // Invalidate env cache so pipeline picks up new keys
        loadEnv(true);
        return Response.json({ ok: true });
      })();
    }

    // --- Workflows ---

    // GET /api/workflows — list all workflows
    if (path === "/api/workflows" && req.method === "GET") {
      const workflows = getWorkflows().map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        source: w.source,
        tts_provider: w.tts_provider,
        language: w.language,
        use_lipsync: w.use_lipsync,
        steps: resolveSteps(w),
      }));
      return Response.json(workflows);
    }

    // GET /api/workflows/:id — get workflow with YAML
    const wfGetMatch = path.match(/^\/api\/workflows\/(.+)$/);
    if (wfGetMatch && req.method === "GET") {
      const wf = getWorkflow(wfGetMatch[1]);
      if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });
      return Response.json(wf);
    }

    // POST /api/workflows — save workflow
    if (path === "/api/workflows" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        if (!body.id || !body.yaml_content) {
          return Response.json({ error: "id and yaml_content required" }, { status: 400 });
        }
        const result = saveWorkflow(body.id, body.yaml_content);
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: 400 });
        }
        return Response.json({ ok: true });
      })();
    }

    // DELETE /api/workflows/:id
    const wfDeleteMatch = path.match(/^\/api\/workflows\/(.+)$/);
    if (wfDeleteMatch && req.method === "DELETE") {
      const deleted = deleteWorkflow(wfDeleteMatch[1]);
      if (!deleted) return Response.json({ error: "Cannot delete file-based workflow" }, { status: 400 });
      return Response.json({ ok: true });
    }

    // POST /api/workflows/generate — brief → YAML via AI agent
    if (path === "/api/workflows/generate" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        const brief = body.brief;
        if (!brief) return Response.json({ error: "brief required" }, { status: 400 });

        const prompt = `สร้าง pipeline workflow YAML สำหรับ content production จาก brief นี้:

${brief}

ตอบเป็น YAML format ตามนี้:
name: [ชื่อ workflow]
description: [อธิบาย 1 บรรทัด]
steps:
  - name: voice
    provider: [elevenlabs / chatterbox / f5tts-thai]
    config:
      language: [th / en]
  - name: images
    provider: modal-flux
    config:
      style: "[describe image style in English]"
      count: auto
  - name: lipsync
    provider: modal-ltx
  - name: captions
    provider: whisper-local
  - name: assembly
    provider: ffmpeg
  - name: thumbnail
    provider: playwright

เลือก steps ที่เหมาะกับ brief ไม่ต้องใส่ทุก step ถ้าไม่จำเป็น
ตอบ YAML เท่านั้น ไม่ต้อง markdown code block`;

        const agentId = resolveAgentId(body.agent_id);
        if (!agentId) return Response.json({ error: "No AI agent configured. Set Default Agent in Settings first." }, { status: 400 });
        const response = await sendToAgent(agentId, prompt, 60);

        if (response.success) {
          // Clean markdown code blocks if present
          let yamlText = response.message
            .replace(/```ya?ml\n?/gi, "")
            .replace(/```\n?/g, "")
            .trim();
          return Response.json({ ok: true, yaml: yamlText });
        } else {
          return Response.json({ error: "Agent failed: " + response.message }, { status: 500 });
        }
      })();
    }

    // --- Production Pipeline ---

    // POST /api/production/:id/start — start production pipeline
    const prodStartMatch = path.match(/^\/api\/production\/(\d+)\/start$/);
    if (prodStartMatch && req.method === "POST") {
      const contentId = parseInt(prodStartMatch[1]);
      const content = getContentById(contentId) as any;
      if (!content) return Response.json({ error: "Content not found" }, { status: 404 });

      // Start pipeline in background (handles cleanup + status internally)
      startPipeline(contentId).catch((err) => {
        console.error(`❌ Pipeline failed for content ${contentId}:`, err);
      });

      return Response.json({ ok: true, message: "Production started" });
    }

    // GET /api/production/:id — get pipeline status
    const prodStatusMatch = path.match(/^\/api\/production\/(\d+)$/);
    if (prodStatusMatch && req.method === "GET") {
      const contentId = parseInt(prodStatusMatch[1]);
      const jobs = getPipelineJobs(contentId);
      return Response.json(jobs);
    }

    // POST /api/production/:id/retry/:step — retry a failed step
    const prodRetryMatch = path.match(/^\/api\/production\/(\d+)\/retry\/(.+)$/);
    if (prodRetryMatch && req.method === "POST") {
      const contentId = parseInt(prodRetryMatch[1]);
      const step = prodRetryMatch[2];

      retryStep(contentId, step).catch((err) => {
        console.error(`❌ Retry failed for ${step}:`, err);
      });

      return Response.json({ ok: true, message: `Retrying ${step}` });
    }

    // POST /api/production/:id/stop/:step — stop a running step
    const prodStopMatch = path.match(/^\/api\/production\/(\d+)\/stop\/(.+)$/);
    if (prodStopMatch && req.method === "POST") {
      const contentId = parseInt(prodStopMatch[1]);
      const step = prodStopMatch[2];

      // Kill Modal process for this step
      const scriptMap: Record<string, string> = {
        images: "flux_image",
        lipsync: "lipsync",
        voice: "chatterbox_tts",
      };
      const pattern = scriptMap[step] || step;
      try {
        require("child_process").execSync(`pkill -f 'modal run.*${pattern}' 2>/dev/null || true`);
      } catch {}

      // Update status to failed
      const jobs = getPipelineJobs(contentId);
      const job = jobs.find((j: any) => j.step === step && j.status === "running");
      if (job) {
        updatePipelineJob(job.id, {
          status: "failed",
          error: "Stopped by user",
          completed_at: new Date().toISOString(),
        });
      }

      return Response.json({ ok: true, message: `Stopped ${step}` });
    }

    // POST /api/production/:id/reset — reset back to script_approved
    const prodResetMatch = path.match(/^\/api\/production\/(\d+)\/reset$/);
    if (prodResetMatch && req.method === "POST") {
      const contentId = parseInt(prodResetMatch[1]);
      deletePipelineJobs(contentId);
      updateContentStatus(contentId, "script_approved");
      return Response.json({ ok: true, message: "Reset to script_approved" });
    }

    // DELETE /api/channels/:id
    const chDeleteMatch = path.match(/^\/api\/channels\/(.+)$/);
    if (chDeleteMatch && req.method === "DELETE") {
      const id = chDeleteMatch[1];
      deleteChannel(id);
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🚀 Content Dashboard running at http://localhost:${PORT}`);

// --- Daily Cron: Scan all channels at 7:00 AM ---
function scheduleDailyScan() {
  const now = new Date();
  const next7am = new Date(now);
  next7am.setHours(7, 3, 0, 0); // 07:03 to avoid :00 congestion
  if (next7am <= now) next7am.setDate(next7am.getDate() + 1);

  const delay = next7am.getTime() - now.getTime();
  console.log(`⏰ Next daily scan at ${next7am.toLocaleString("th-TH")} (in ${Math.round(delay / 60000)} min)`);

  setTimeout(async () => {
    console.log("⏰ Daily scan triggered!");
    const channels = getChannels() as any[];
    for (const ch of channels) {
      if (!ch.agent_id) continue;
      console.log(`  📡 Scanning ${ch.name}...`);
      // Call our own scan API
      await fetch(`http://localhost:${PORT}/api/scan/${ch.id}`, { method: "POST" });
      // Stagger between channels
      await new Promise((r) => setTimeout(r, 5000));
    }
    // Schedule next day
    scheduleDailyScan();
  }, delay);
}

scheduleDailyScan();
