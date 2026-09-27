"use strict";

require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const ownerrez = require("./src/ownerrez");
const triage = require("./src/triage");
const guestqa = require("./src/guestqa");
const db = require("./src/db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// Very basic auth for the dashboard + API. Fine for an internal pilot
// behind a not-widely-shared URL; replace with real auth before this
// touches anything sensitive long-term.
// ---------------------------------------------------------------------
function requireDashboardAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASSWORD) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="B2 Ops"');
  return res.status(401).send("Authentication required.");
}

// ---------------------------------------------------------------------
// OwnerRez OAuth connect flow — run this once (or whenever the refresh
// token needs re-issuing) to authorize the app against your OwnerRez
// account. Visit /oauth/start in a browser while logged into OwnerRez.
// ---------------------------------------------------------------------
app.get("/oauth/start", requireDashboardAuth, (req, res) => {
  res.redirect(ownerrez.authorizeUrl());
});

app.get("/oauth/callback", requireDashboardAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OwnerRez returned an error: ${error}`);
  if (!code) return res.status(400).send("Missing authorization code.");
  try {
    await ownerrez.exchangeCodeForToken(code);
    res.send("OwnerRez connected successfully. You can close this tab.");
  } catch (e) {
    console.error(e);
    res.status(500).send("Token exchange failed — check server logs.");
  }
});

// ---------------------------------------------------------------------
// Webhook receiver. Set this URL, plus OWNERREZ_WEBHOOK_USER/PASSWORD,
// in OwnerRez's Developer/API > Webhooks settings.
//
// IMPORTANT: the exact JSON shape OwnerRez sends for a "new message"
// event hasn't been observed yet in this build — every payload is
// logged to the webhook_log table regardless of whether extraction
// below succeeds, specifically so the real shape can be inspected on
// the first live webhook and this handler adjusted to match.
// ---------------------------------------------------------------------
app.post("/webhooks/ownerrez", express.json(), async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, encoded] = authHeader.split(" ");
  let ok = false;
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    ok = user === process.env.OWNERREZ_WEBHOOK_USER && pass === process.env.OWNERREZ_WEBHOOK_PASSWORD;
  }
  if (!ok) return res.status(401).send("Unauthorized webhook.");

  const payload = req.body;
  db.logWebhook(payload && payload.type, payload, "received");

  // Always ack quickly; do the real work after responding so OwnerRez
  // doesn't time out waiting on the Claude API call.
  res.status(200).send("ok");

  // --- Duplicate delivery protection ---
  // Prefer an explicit id OwnerRez provides; fall back to hashing the
  // whole payload so even an unlabeled exact-duplicate retry is caught.
  const idempotencyKey =
    (payload && String(payload.id || payload.event_id || payload.webhook_id || payload.delivery_id || "")) ||
    crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
  if (!db.tryMarkEventProcessed(idempotencyKey)) {
    db.logWebhook(payload && payload.type, payload, "duplicate_ignored");
    return;
  }

  try {
    // --- Best-effort extraction — VERIFY against a real payload. ---
    const eventType = payload && (payload.type || payload.event || payload.eventType);
    const isMessageEvent = typeof eventType === "string" && eventType.toLowerCase().includes("message");
    if (!isMessageEvent) {
      db.logWebhook(eventType, payload, "ignored_non_message_event");
      return;
    }

    const threadId =
      (payload.data && (payload.data.id || payload.data.threadId)) ||
      payload.id ||
      payload.threadId;
    if (!threadId) {
      db.logWebhook(eventType, payload, "no_thread_id_found");
      return;
    }

    // If staff already took this thread over directly (see below), don't
    // auto-process anything further on it until someone resumes it.
    if (db.isThreadPaused(threadId)) {
      db.logWebhook(eventType, payload, "skipped_thread_paused");
      return;
    }

    const thread = await ownerrez.getMessageThread(threadId);

    // Best-effort: pull the latest guest message text and identifying ids
    // out of the thread. Field names here are a reasonable guess and
    // should be corrected once a real thread response has been seen.
    const messages = thread.messages || thread.items || [];

    // --- Human-takeover detection ---
    // Any "host"-direction message in this thread that ISN'T something we
    // ourselves sent (checked against our own stored assistant replies)
    // means a staff member replied directly in OwnerRez. When that
    // happens, hand the whole thread to that human — pause automation on
    // it entirely rather than risk the bot talking over a real person.
    const ourPriorReplies = db.getRecentTurns(threadId, 50)
      .filter((t) => t.role === "assistant")
      .map((t) => t.content);
    const staffMessage = messages.find((m) => {
      const dir = m.direction || m.from;
      const body = m.body || m.text || "";
      return dir === "host" && body && ourPriorReplies.indexOf(body) === -1;
    });
    if (staffMessage) {
      db.pauseThread(threadId, "Staff replied directly in OwnerRez — automation paused for this guest");
      db.logWebhook(eventType, payload, "paused_staff_detected");
      return;
    }

    const lastGuestMessage = [...messages].reverse().find((m) => (m.direction || m.from) !== "host");
    const messageText = (lastGuestMessage && (lastGuestMessage.body || lastGuestMessage.text)) || "";
    const propertyId = thread.property_id || thread.propertyId;
    const bookingId = thread.booking_id || thread.bookingId;

    if (!messageText) {
      db.logWebhook(eventType, payload, "no_message_text_found");
      return;
    }

    // Pull verified, guest-facing facts for this property and booking so
    // the AI can only answer from real data — never improvise.
    let propertyInfo = { name: `Property #${propertyId || "unknown"}` };
    let doorCodes = [];
    try {
      if (propertyId) {
        propertyInfo = await ownerrez.getPropertyGuestInfo(propertyId);
        db.upsertProperty(propertyId, propertyInfo.name);
      }
    } catch (e) {
      console.error("Couldn't fetch property guest info:", e);
    }
    try {
      if (bookingId) {
        doorCodes = await ownerrez.getBookingDoorCodes(bookingId);
        const stay = await ownerrez.getBookingStayInfo(bookingId);
        propertyInfo.checkinDateTime = stay.checkinDateTime;
        propertyInfo.checkoutDateTime = stay.checkoutDateTime;
      }
    } catch (e) {
      console.error("Couldn't fetch booking door codes / stay info:", e);
    }

    // Prior turns for this thread, so the AI has real conversational
    // memory instead of treating every message as a cold start.
    const priorTurns = db.getRecentTurns(threadId, 20);

    const result = await guestqa.routeMessage(propertyInfo, doorCodes, priorTurns, messageText);

    // Record both sides of this exchange regardless of outcome, so the
    // NEXT message in this thread has full context.
    db.appendConversationTurn(threadId, "user", messageText);
    if (result.reply) db.appendConversationTurn(threadId, "assistant", result.reply);

    // Send the reply (covers both plain answers and acknowledgment of an
    // escalated issue — guests should never be met with silence).
    if (result.reply) {
      try {
        await ownerrez.sendMessage(threadId, result.reply);
      } catch (e) {
        console.error("Send failed:", e);
        try {
          await ownerrez.sendMessage(threadId, guestqa.FALLBACK_REPLY);
        } catch (e2) {
          console.error("Even the fallback send failed:", e2);
        }
      }
    } else {
      try {
        await ownerrez.sendMessage(threadId, guestqa.FALLBACK_REPLY);
      } catch (e) {
        console.error("Fallback send failed:", e);
      }
    }

    if (result.escalationType === "maintenance") {
      db.insertWorkOrder({
        property: propertyInfo.name,
        ownerRezPropertyId: propertyId || null,
        guestMessage: messageText,
        title: result.title || `${result.category || "other"} issue — ${propertyInfo.name}`,
        description: result.description || messageText,
        category: result.category || "other",
        priority: result.priority || "routine",
        assignee: triage.defaultAssigneeFor(result.category || "other"),
        status: "new",
        source: "ownerrez_webhook",
        ownerRezThreadId: String(threadId)
      });
      db.logWebhook(eventType, payload, "work_order_created");
    } else if (result.escalationType === "billing_admin") {
      db.insertWorkOrder({
        property: propertyInfo.name,
        ownerRezPropertyId: propertyId || null,
        guestMessage: messageText,
        title: result.title || `Billing/booking request — ${propertyInfo.name}`,
        description: result.description || messageText,
        category: "billing_admin",
        priority: result.priority || "high",
        assignee: "Office Admin — Tracy Leonard / Leila Wilson (office@b2vacations.com)",
        status: "new",
        source: "ownerrez_webhook",
        ownerRezThreadId: String(threadId)
      });
      db.logWebhook(eventType, payload, "billing_admin_ticket_created");
    } else if (result.escalationType === "housekeeping") {
      db.insertWorkOrder({
        property: propertyInfo.name,
        ownerRezPropertyId: propertyId || null,
        guestMessage: messageText,
        title: result.title || `Housekeeping/cleanliness issue — ${propertyInfo.name}`,
        description: result.description || messageText,
        category: "housekeeping",
        priority: result.priority || "high",
        assignee: "Sylvia Garcia / Devin Rios / Chanda Enand (Housekeeping Review)",
        status: "new",
        source: "ownerrez_webhook",
        ownerRezThreadId: String(threadId)
      });
      db.logWebhook(eventType, payload, "housekeeping_ticket_created");
    } else if (result.escalationType === "question_followup") {
      db.logGuestQa({
        property: propertyInfo.name,
        threadId: String(threadId),
        question: messageText,
        answer: result.reply,
        answeredAutomatically: false
      });
      db.logWebhook(eventType, payload, "question_partially_answered_flagged");
    } else {
      db.logWebhook(eventType, payload, "answered_automatically");
    }
  } catch (e) {
    console.error("Webhook processing failed:", e);
    db.logWebhook("error", { message: String(e) }, "error");
  }
});

// ---------------------------------------------------------------------
// Simple JSON API for the dashboard.
// ---------------------------------------------------------------------
app.get("/api/work-orders", requireDashboardAuth, (req, res) => {
  res.json(db.listWorkOrders());
});

app.get("/api/unanswered-questions", requireDashboardAuth, (req, res) => {
  res.json(db.listUnansweredQuestions());
});

app.get("/api/conversation/:threadId", requireDashboardAuth, (req, res) => {
  res.json(db.getRecentTurns(req.params.threadId, 100));
});

app.get("/api/paused-threads", requireDashboardAuth, (req, res) => {
  res.json(db.listPausedThreads());
});

app.get("/api/conversations", requireDashboardAuth, (req, res) => {
  res.json(db.listRecentConversations());
});

app.post("/api/threads/:threadId/pause", requireDashboardAuth, (req, res) => {
  db.pauseThread(req.params.threadId, "Manually paused by staff");
  res.json({ ok: true });
});

app.post("/api/threads/:threadId/resume", requireDashboardAuth, (req, res) => {
  db.resumeThread(req.params.threadId);
  res.json({ ok: true });
});

app.get("/api/properties", requireDashboardAuth, (req, res) => {
  res.json(db.listCachedProperties());
});

app.post("/api/properties/sync", requireDashboardAuth, async (req, res) => {
  try {
    const count = await syncProperties();
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function syncProperties() {
  const props = await ownerrez.listAllProperties();
  props.forEach((p) => {
    const id = p.id || p.property_id;
    const name = p.name || p.property_name;
    if (id) db.upsertProperty(id, name);
  });
  return props.length;
}

// Best-effort background sync so the property list stays current without
// a manual click every time. Runs once shortly after startup, then every
// 6 hours. Silently no-ops until OwnerRez is connected.
setTimeout(() => {
  syncProperties().catch((e) => console.log("Initial property sync skipped:", e.message));
}, 15000);
setInterval(() => {
  syncProperties().catch((e) => console.log("Scheduled property sync failed:", e.message));
}, 6 * 60 * 60 * 1000);

app.post("/api/work-orders/:id/status", requireDashboardAuth, (req, res) => {
  const { status } = req.body;
  if (!["new", "in_progress", "completed"].includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }
  db.updateWorkOrderStatus(req.params.id, status);
  res.json({ ok: true });
});

// Manual test endpoint — triage arbitrary text without waiting for a
// real webhook, useful for confirming ANTHROPIC_API_KEY works.
app.post("/api/test-triage", requireDashboardAuth, async (req, res) => {
  try {
    const { property, message } = req.body;
    const result = await triage.triageMessage(property, message);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Fixture data for the in-dashboard test harness — lets staff validate the
// full conversational router (tone, multi-turn memory, escalation routing)
// without needing a live OwnerRez connection at all.
const SAMPLE_PROPERTY = {
  name: "Test Property — BF4 404",
  wifiNetwork: "B2Guest_BF4404",
  wifiPassword: "SunnyDays24",
  checkinInstructions: "Use the keypad at the front door; the code is listed below.",
  directions: "From Hwy 17, turn onto Ocean Blvd, second building on the right.",
  houseManual: "Please remove trash before departure. No smoking indoors. Quiet hours after 10 PM.",
  bedroomDetails: "3 bedrooms: 1 king, 1 queen, 2 twin bunks.",
  bathroomDetails: "2 full bathrooms.",
  checkinDateTime: "4:00 PM",
  checkoutDateTime: "10:00 AM"
};
const SAMPLE_DOOR_CODES = [{ code: "4521", lockNames: ["Front Door"] }];

app.post("/api/test-guestqa", requireDashboardAuth, async (req, res) => {
  try {
    const { message, threadId } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    const tid = "test:" + (threadId || "default");
    const priorTurns = db.getRecentTurns(tid, 20);
    const result = await guestqa.routeMessage(SAMPLE_PROPERTY, SAMPLE_DOOR_CODES, priorTurns, message);
    db.appendConversationTurn(tid, "user", message);
    if (result.reply) db.appendConversationTurn(tid, "assistant", result.reply);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`B2 OwnerRez automation listening on port ${PORT}`);
});
