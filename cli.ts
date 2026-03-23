#!/usr/bin/env bun
/**
 * ClawContent CLI — for OpenClaw agent exec or direct terminal use
 *
 * Usage: clawcontent <command> [args]
 * Requires: bun run dev (server at localhost:3456)
 */

const BASE = process.env.CLAWCONTENT_URL || "http://localhost:3456";

async function api(path: string, method = "GET", body?: any) {
  const opts: any = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    return res.json();
  } catch {
    console.error("Error: ClawContent server not running. Start with: bun run dev");
    process.exit(1);
  }
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  // --- Channels ---
  case "channels": {
    const channels = await api("/api/channels");
    for (const ch of channels) {
      const counts = Object.entries(ch.counts || {}).map(([k, v]) => `${v} ${k}`).join(", ");
      console.log(`${ch.id} — ${ch.name} [${counts || "empty"}]`);
    }
    break;
  }

  // --- Content Discovery ---
  case "scan": {
    const channel = args[0];
    if (!channel) { console.error("Usage: clawcontent scan <channel-id>"); process.exit(1); }
    const result = await api(`/api/scan/${channel}`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  case "ideas": {
    const channel = args[0];
    if (!channel) { console.error("Usage: clawcontent ideas <channel-id>"); process.exit(1); }
    const items = await api(`/api/content?channel=${channel}&status=discovered`);
    for (const item of items) {
      console.log(`[${item.id}] ${item.title}`);
      if (item.summary) console.log(`    ${item.summary.slice(0, 100)}`);
    }
    if (items.length === 0) console.log("No ideas yet — run: clawcontent scan " + channel);
    break;
  }

  // --- Content Actions ---
  case "approve": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent approve <content-id>"); process.exit(1); }
    await api(`/api/content/${id}/approve`, "POST");
    console.log(`Content ${id} approved`);
    break;
  }

  case "reject": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent reject <content-id>"); process.exit(1); }
    await api(`/api/content/${id}/reject`, "POST");
    console.log(`Content ${id} rejected`);
    break;
  }

  // --- Script ---
  case "script": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent script <content-id>"); process.exit(1); }
    const result = await api(`/api/script/${id}/generate`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  case "script-view": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent script-view <content-id>"); process.exit(1); }
    const script = await api(`/api/script/${id}`);
    console.log(script.draft_text || script.approved_text || "No script yet");
    break;
  }

  case "script-approve": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent script-approve <content-id>"); process.exit(1); }
    await api(`/api/script/${id}/approve`, "POST");
    console.log(`Script ${id} approved`);
    break;
  }

  // --- Production ---
  case "produce": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent produce <content-id>"); process.exit(1); }
    const result = await api(`/api/production/${id}/start`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  case "status": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent status <content-id>"); process.exit(1); }
    const jobs = await api(`/api/production/${id}`);
    for (const job of jobs) {
      const icon = job.status === "done" ? "✅" : job.status === "running" ? "⚡" : job.status === "failed" ? "❌" : "⏳";
      let line = `${icon} ${job.step} — ${job.status}`;
      if (job.error) line += ` (${job.error.slice(0, 80)})`;
      console.log(line);
    }

    // Show lipsync chunks if running/failed
    const lipsync = jobs.find((j: any) => j.step === "lipsync" && (j.status === "running" || j.status === "failed"));
    if (lipsync) {
      const chunks = await api(`/api/lipsync-chunks/${id}`);
      if (chunks.total > 0) {
        console.log(`  Chunks: ${chunks.done}/${chunks.total}`);
      }
    }
    break;
  }

  case "stop": {
    const id = args[0];
    const step = args[1];
    if (!id || !step) { console.error("Usage: clawcontent stop <content-id> <step>"); process.exit(1); }
    const result = await api(`/api/production/${id}/stop/${step}`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  case "retry": {
    const id = args[0];
    const step = args[1];
    if (!id || !step) { console.error("Usage: clawcontent retry <content-id> <step>"); process.exit(1); }
    const result = await api(`/api/production/${id}/retry/${step}`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  case "reset": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent reset <content-id>"); process.exit(1); }
    const result = await api(`/api/production/${id}/reset`, "POST");
    console.log(JSON.stringify(result));
    break;
  }

  // --- Publishing ---
  case "publish": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent publish <content-id>"); process.exit(1); }
    const result = await api(`/api/publish/${id}`, "POST", { platforms: ["youtube"] });
    console.log(JSON.stringify(result));
    break;
  }

  case "seo": {
    const id = args[0];
    if (!id) { console.error("Usage: clawcontent seo <content-id>"); process.exit(1); }
    const result = await api(`/api/publish/${id}/seo`, "POST");
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  // --- Help ---
  default: {
    console.log(`ClawContent CLI — Content Automation

Usage: clawcontent <command> [args]

Discovery:
  channels                    List all channels
  scan <channel>              Scan for news/ideas
  ideas <channel>             List discovered content

Content:
  approve <id>                Approve content
  reject <id>                 Reject content

Script:
  script <id>                 Generate script
  script-view <id>            View script text
  script-approve <id>         Approve script

Production:
  produce <id>                Start production pipeline
  status <id>                 Pipeline status (all steps + chunks)
  stop <id> <step>            Stop a running step
  retry <id> <step>           Retry a failed/done step
  reset <id>                  Reset to script_approved

Publishing:
  publish <id>                Publish content
  seo <id>                    Generate SEO metadata

Requires: bun run dev (server at localhost:3456)`);
  }
}
