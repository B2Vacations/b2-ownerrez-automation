"use strict";

const Database = require("better-sqlite3");
const path = require("path");

// NOTE: SQLite writes to a local file. Fine for a pilot on a host with a
// persistent disk (Render/Railway/Fly.io persistent volume, a VPS). On a
// purely stateless/serverless host, this file will NOT survive redeploys —
// swap in Postgres before relying on this beyond testing.
const db = new Database(path.join(__dirname, "..", "data.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property TEXT,
    ownerrez_property_id TEXT,
    guest_message TEXT,
    title TEXT,
    description TEXT,
    category TEXT,
    priority TEXT,
    status TEXT DEFAULT 'new',
    assignee TEXT,
    source TEXT,
    ownerrez_thread_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS properties (
    ownerrez_property_id TEXT PRIMARY KEY,
    name TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS webhook_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT DEFAULT (datetime('now')),
    event_type TEXT,
    payload TEXT,
    status TEXT
  );

  CREATE TABLE IF NOT EXISTS guest_qa_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property TEXT,
    thread_id TEXT,
    question TEXT,
    answer TEXT,
    answered_automatically INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_thread ON conversation_turns (thread_id, id);

  CREATE TABLE IF NOT EXISTS processed_events (
    event_key TEXT PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS thread_flags (
    thread_id TEXT PRIMARY KEY,
    paused INTEGER DEFAULT 0,
    paused_at TEXT,
    reason TEXT
  );
`);

// Migration-safe: adds the column if this DB pre-dates it. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we probe and swallow the "duplicate
// column" error on a DB that already has it.
try {
  db.exec("ALTER TABLE work_orders ADD COLUMN ownerrez_property_id TEXT");
} catch (e) {
  // Already exists — fine.
}

function insertWorkOrder(o) {
  const stmt = db.prepare(`
    INSERT INTO work_orders
      (property, ownerrez_property_id, guest_message, title, description, category, priority, status, assignee, source, ownerrez_thread_id)
    VALUES (@property, @ownerrez_property_id, @guest_message, @title, @description, @category, @priority, @status, @assignee, @source, @ownerrez_thread_id)
  `);
  const info = stmt.run({
    property: o.property || "",
    ownerrez_property_id: o.ownerRezPropertyId != null ? String(o.ownerRezPropertyId) : null,
    guest_message: o.guestMessage || "",
    title: o.title || "",
    description: o.description || "",
    category: o.category || "other",
    priority: o.priority || "routine",
    status: o.status || "new",
    assignee: o.assignee || "Unassigned",
    source: o.source || "ownerrez_webhook",
    ownerrez_thread_id: o.ownerRezThreadId || null
  });
  return info.lastInsertRowid;
}

function listWorkOrders() {
  return db.prepare("SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 500").all();
}

function updateWorkOrderStatus(id, status) {
  db.prepare("UPDATE work_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function logWebhook(eventType, payload, status) {
  db.prepare("INSERT INTO webhook_log (event_type, payload, status) VALUES (?, ?, ?)").run(
    eventType,
    JSON.stringify(payload),
    status
  );
}

function logGuestQa(entry) {
  db.prepare(`
    INSERT INTO guest_qa_log (property, thread_id, question, answer, answered_automatically)
    VALUES (@property, @thread_id, @question, @answer, @answered_automatically)
  `).run({
    property: entry.property || "",
    thread_id: entry.threadId || null,
    question: entry.question || "",
    answer: entry.answer || null,
    answered_automatically: entry.answeredAutomatically ? 1 : 0
  });
}

function listUnansweredQuestions() {
  return db
    .prepare("SELECT * FROM guest_qa_log WHERE answered_automatically = 0 ORDER BY created_at DESC LIMIT 200")
    .all();
}

function upsertProperty(id, name) {
  db.prepare(`
    INSERT INTO properties (ownerrez_property_id, name, synced_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(ownerrez_property_id) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at
  `).run(String(id), name || "");
}

function listCachedProperties() {
  return db.prepare("SELECT * FROM properties ORDER BY name ASC").all();
}

function appendConversationTurn(threadId, role, content) {
  db.prepare("INSERT INTO conversation_turns (thread_id, role, content) VALUES (?, ?, ?)").run(
    String(threadId),
    role,
    content
  );
}

// Returns the most recent turns for a thread, OLDEST FIRST (ready to hand
// straight to the Claude API as prior conversation turns), capped so a
// very long guest stay doesn't blow out the prompt size indefinitely.
function getRecentTurns(threadId, limit) {
  limit = limit || 20;
  var rows = db
    .prepare("SELECT role, content FROM conversation_turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
    .all(String(threadId), limit);
  return rows.reverse();
}

// --- Webhook idempotency ---
// Returns true if this is the FIRST time this key has been seen (i.e. safe
// to process), false if it's a duplicate delivery that should be skipped.
// The INSERT-and-catch pattern is atomic under SQLite's UNIQUE constraint,
// so this is safe even if two deliveries arrive back-to-back.
function tryMarkEventProcessed(key) {
  try {
    db.prepare("INSERT INTO processed_events (event_key) VALUES (?)").run(key);
    return true;
  } catch (e) {
    return false; // UNIQUE constraint hit — already processed.
  }
}

// --- Thread pause (human takeover) ---
function isThreadPaused(threadId) {
  const row = db.prepare("SELECT paused FROM thread_flags WHERE thread_id = ?").get(String(threadId));
  return !!(row && row.paused);
}

function pauseThread(threadId, reason) {
  db.prepare(`
    INSERT INTO thread_flags (thread_id, paused, paused_at, reason) VALUES (?, 1, datetime('now'), ?)
    ON CONFLICT(thread_id) DO UPDATE SET paused = 1, paused_at = datetime('now'), reason = excluded.reason
  `).run(String(threadId), reason || "");
}

function resumeThread(threadId) {
  db.prepare(`
    INSERT INTO thread_flags (thread_id, paused, paused_at, reason) VALUES (?, 0, datetime('now'), NULL)
    ON CONFLICT(thread_id) DO UPDATE SET paused = 0, paused_at = datetime('now'), reason = NULL
  `).run(String(threadId));
}

function listPausedThreads() {
  return db.prepare("SELECT * FROM thread_flags WHERE paused = 1 ORDER BY paused_at DESC").all();
}

// Every thread we've ever exchanged messages on, newest activity first,
// with its current pause state — powers a manual pause/resume toggle for
// any conversation, not just ones already auto-paused.
function listRecentConversations(limit) {
  limit = limit || 100;
  return db.prepare(`
    SELECT
      ct.thread_id AS thread_id,
      MAX(ct.created_at) AS last_activity,
      (SELECT content FROM conversation_turns WHERE thread_id = ct.thread_id ORDER BY id DESC LIMIT 1) AS last_message,
      COALESCE(tf.paused, 0) AS paused
    FROM conversation_turns ct
    LEFT JOIN thread_flags tf ON tf.thread_id = ct.thread_id
    GROUP BY ct.thread_id
    ORDER BY last_activity DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  insertWorkOrder,
  listWorkOrders,
  updateWorkOrderStatus,
  getSetting,
  setSetting,
  logWebhook,
  logGuestQa,
  listUnansweredQuestions,
  upsertProperty,
  listCachedProperties,
  appendConversationTurn,
  getRecentTurns,
  tryMarkEventProcessed,
  isThreadPaused,
  pauseThread,
  resumeThread,
  listPausedThreads,
  listRecentConversations
};
