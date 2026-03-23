import { Database } from "bun:sqlite";

const DB_PATH = import.meta.dir + "/data.db";

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.run("PRAGMA journal_mode = WAL");

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    agent_id TEXT,
    research_type TEXT DEFAULT 'news',
    pipeline_steps TEXT DEFAULT '[]',
    accent_color TEXT DEFAULT '#FF6600',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'news',
    status TEXT NOT NULL DEFAULT 'discovered',
    title TEXT NOT NULL,
    summary TEXT,
    source_url TEXT,
    source_data TEXT,
    ep_number TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    version INTEGER DEFAULT 1,
    draft_text TEXT,
    approved_text TEXT,
    status TEXT DEFAULT 'draft',
    agent_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (content_id) REFERENCES content(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,
    step TEXT NOT NULL,
    step_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    output_path TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (content_id) REFERENCES content(id)
  )
`);

// Add columns to channels if not exists
try { db.run("ALTER TABLE channels ADD COLUMN avatar_url TEXT DEFAULT ''"); } catch {}
try { db.run("ALTER TABLE channels ADD COLUMN tts_provider TEXT DEFAULT 'elevenlabs'"); } catch {}
try { db.run("ALTER TABLE channels ADD COLUMN workflow_id TEXT DEFAULT 'full-video-thai'"); } catch {}
try { db.run("ALTER TABLE channels ADD COLUMN orientation TEXT DEFAULT 'landscape'"); } catch {}
try { db.run("ALTER TABLE channels ADD COLUMN video_duration TEXT DEFAULT '3-4min'"); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Content status: discovered → approved → scripted → script_approved → producing → done → rejected
// Script status: draft → approved → rejected
// Pipeline job status: pending → running → done → failed → skipped

// --- Queries ---

export function getChannels() {
  return db.query("SELECT * FROM channels ORDER BY name").all();
}

export function getChannel(id: string) {
  return db.query("SELECT * FROM channels WHERE id = ?").get(id);
}

export function upsertChannel(ch: {
  id: string;
  name: string;
  description?: string;
  agent_id?: string;
  research_type?: string;
  pipeline_steps?: string[];
  accent_color?: string;
  avatar_url?: string;
  tts_provider?: string;
  workflow_id?: string;
  orientation?: string;
  video_duration?: string;
}) {
  db.run(
    `INSERT OR REPLACE INTO channels (id, name, description, agent_id, research_type, pipeline_steps, accent_color, avatar_url, tts_provider, workflow_id, orientation, video_duration, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      ch.id,
      ch.name,
      ch.description || "",
      ch.agent_id || null,
      ch.research_type || "news",
      JSON.stringify(ch.pipeline_steps || []),
      ch.accent_color || "#FF6600",
      ch.avatar_url || "",
      ch.tts_provider || "elevenlabs",
      ch.workflow_id || "full-video-thai",
      ch.orientation || "landscape",
      ch.video_duration || "3-4min",
    ]
  );
}

export function getContent(channelId?: string, status?: string) {
  let sql = "SELECT * FROM content WHERE 1=1";
  const params: string[] = [];
  if (channelId) {
    sql += " AND channel_id = ?";
    params.push(channelId);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC";
  return db.query(sql).all(...params);
}

export function getContentById(id: number) {
  return db.query("SELECT * FROM content WHERE id = ?").get(id);
}

export function addContent(item: {
  channel_id: string;
  type: string;
  title: string;
  summary?: string;
  source_url?: string;
  source_data?: string;
}) {
  const result = db.run(
    `INSERT INTO content (channel_id, type, title, summary, source_url, source_data)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      item.channel_id,
      item.type,
      item.title,
      item.summary || "",
      item.source_url || "",
      item.source_data || "",
    ]
  );
  return result.lastInsertRowid;
}

export function updateContentStatus(id: number, status: string) {
  db.run(
    "UPDATE content SET status = ?, updated_at = datetime('now') WHERE id = ?",
    [status, id]
  );
}

export function getScript(contentId: number) {
  return db
    .query(
      "SELECT * FROM scripts WHERE content_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(contentId);
}

export function addScript(contentId: number, draftText: string, agentId?: string) {
  const existing = db
    .query("SELECT MAX(version) as v FROM scripts WHERE content_id = ?")
    .get(contentId) as any;
  const version = (existing?.v || 0) + 1;

  db.run(
    `INSERT INTO scripts (content_id, version, draft_text, agent_id)
     VALUES (?, ?, ?, ?)`,
    [contentId, version, draftText, agentId || null]
  );

  updateContentStatus(contentId, "scripted");
}

export function approveScript(contentId: number) {
  const script = getScript(contentId) as any;
  if (script) {
    db.run(
      "UPDATE scripts SET status = 'approved', approved_text = draft_text, updated_at = datetime('now') WHERE id = ?",
      [script.id]
    );
    updateContentStatus(contentId, "script_approved");
  }
}

export function deleteChannel(id: string) {
  // Cascade: delete pipeline_jobs and scripts for content in this channel
  db.run("DELETE FROM pipeline_jobs WHERE content_id IN (SELECT id FROM content WHERE channel_id = ?)", [id]);
  db.run("DELETE FROM scripts WHERE content_id IN (SELECT id FROM content WHERE channel_id = ?)", [id]);
  db.run("DELETE FROM content WHERE channel_id = ?", [id]);
  db.run("DELETE FROM channels WHERE id = ?", [id]);
}

export function getContentCounts(channelId: string) {
  const rows = db
    .query(
      "SELECT status, COUNT(*) as count FROM content WHERE channel_id = ? GROUP BY status"
    )
    .all(channelId) as any[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

// --- Pipeline Job Queries ---

export function createPipelineJob(job: {
  content_id: number;
  step_name: string;
  step_order: number;
  status?: string;
}) {
  db.run(
    `INSERT INTO pipeline_jobs (content_id, step, step_order, status) VALUES (?, ?, ?, ?)`,
    [job.content_id, job.step_name, job.step_order, job.status || "pending"]
  );
}

export function getPipelineJobs(contentId: number) {
  return db
    .query(
      "SELECT * FROM pipeline_jobs WHERE content_id = ? ORDER BY step_order ASC"
    )
    .all(contentId) as any[];
}

export function getPipelineJob(contentId: number, step: string) {
  return db
    .query(
      "SELECT * FROM pipeline_jobs WHERE content_id = ? AND step = ? ORDER BY id DESC LIMIT 1"
    )
    .get(contentId, step) as any;
}

export function updatePipelineJob(
  jobId: number,
  updates: { status?: string; output_path?: string | null; error?: string | null; started_at?: string; completed_at?: string }
) {
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.output_path !== undefined) { sets.push("output_path = ?"); params.push(updates.output_path); }
  if (updates.error !== undefined) { sets.push("error = ?"); params.push(updates.error); }
  if (updates.started_at) { sets.push("started_at = ?"); params.push(updates.started_at); }
  if (updates.completed_at) { sets.push("completed_at = ?"); params.push(updates.completed_at); }

  if (sets.length === 0) return;

  params.push(jobId);
  db.run(
    `UPDATE pipeline_jobs SET ${sets.join(", ")} WHERE id = ?`,
    params
  );
}

export function deletePipelineJobs(contentId: number) {
  db.run("DELETE FROM pipeline_jobs WHERE content_id = ?", [contentId]);
}

// --- Scan Status ---

db.run(`
  CREATE TABLE IF NOT EXISTS scan_status (
    channel_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'idle',
    message TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

export function setScanStatus(channelId: string, status: string, message: string = "") {
  db.run(
    `INSERT OR REPLACE INTO scan_status (channel_id, status, message, updated_at) VALUES (?, ?, ?, datetime('now'))`,
    [channelId, status, message]
  );
}

export function getScanStatus(channelId: string) {
  return db.query("SELECT * FROM scan_status WHERE channel_id = ?").get(channelId) as any;
}

// --- Task Status (generic for scan, script gen, etc.) ---

db.run(`
  CREATE TABLE IF NOT EXISTS task_status (
    key TEXT PRIMARY KEY,
    status TEXT DEFAULT 'idle',
    message TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

export function setTaskStatus(key: string, status: string, message: string = "") {
  db.run(
    `INSERT OR REPLACE INTO task_status (key, status, message, updated_at) VALUES (?, ?, ?, datetime('now'))`,
    [key, status, message]
  );
}

export function getTaskStatus(key: string) {
  return db.query("SELECT * FROM task_status WHERE key = ?").get(key) as any;
}

// --- Settings Queries ---

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function getAllSettings(): { key: string; value: string; updated_at: string }[] {
  return db.query("SELECT * FROM settings ORDER BY key").all() as any[];
}

export function setSetting(key: string, value: string) {
  db.run(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, value]
  );
}

export function deleteSetting(key: string) {
  db.run("DELETE FROM settings WHERE key = ?", [key]);
}

// Seed Builder with AI channel if not exists
const existing = getChannel("builder-with-ai");
if (!existing) {
  upsertChannel({
    id: "builder-with-ai",
    name: "Builder with AI",
    description:
      "สอนเจ้าของธุรกิจใช้ AI เป็นระบบ — Personal AI, AI Agent, Data Sovereignty",
    agent_id: "",
    research_type: "news",
    pipeline_steps: [
      "script",
      "voice",
      "images",
      "lipsync",
      "captions",
      "assembly",
      "thumbnail",
      "reel",
      "seo",
      "upload",
    ],
    accent_color: "#FF6600",
  });
  console.log("✅ Seeded: Builder with AI channel");
}
