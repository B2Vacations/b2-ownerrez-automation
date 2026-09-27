# B2 OwnerRez Automation

Receives OwnerRez "new message" webhooks (which already cover Airbnb, VRBO,
and direct-booking guests, since OwnerRez's Unified Inbox merges all three)
and does one of two things with each guest message:

1. **It's a question** (WiFi password, check-in time, directions, door
   code...) — answered automatically, using ONLY the verified facts stored
   on that property/booking in OwnerRez (Wi-Fi Password, House Manual,
   Directions, Check-in Instructions, Bedroom/Bathroom Details, check-in/
   checkout date-time, and per-booking door codes). If those fields don't
   contain the answer, the guest still gets a warm, natural reply that
   says a team member will follow up on that part — never a guessed
   answer — and the question is logged so you can see exactly what's
   missing from your property data.
2. **It's a real issue** (something broken/not working) — routed into the
   same AI triage → work order pipeline as before, with a warm
   acknowledgment sent back to the guest so they're not met with silence.

The AI has real conversational memory per message thread — every prior
guest message and every reply it sent are stored and replayed as context
on the next message, so a guest can ask several things across a
conversation ("what's the wifi password?" ... "and the door code?") and
get natural, contextual answers instead of the thread resetting to zero
every time. A single message can also contain several questions or a
question plus an issue report — the AI answers everything it can in one
natural reply and only defers the specific part it can't.

This is a real backend service. It needs to be deployed somewhere with a
public URL and kept running. It is **not** connected to anything yet — you
need to do the steps below with your own OwnerRez account and API keys.

## Safeguards built in

- **Never grants money or policy exceptions.** Discounts, refunds, credits,
  late checkout, early check-in, and rule exceptions always escalate — the
  AI is instructed never to promise or imply one, no matter how confident
  it is what the answer would be. These create a ticket assigned to the
  shared office admin inbox (Tracy Leonard / Leila Wilson), separate from
  the maintenance queue, since a refund request needs an owner, not just
  a log entry.
- **Cleanliness complaints route to housekeeping oversight, not the
  cleaning company directly.** A guest saying the unit was dirty at
  check-in, or reporting missing turnover supplies, creates a ticket
  assigned to Sylvia Garcia, Devin Rios, and Chanda Enand — kept separate
  from "maintenance" (broken/malfunctioning items) since cleanliness is a
  housekeeping oversight matter, not a repair.
- **Duplicate-safe.** Webhook retries (common when a provider doesn't get
  a fast enough response) are detected and ignored — each event is only
  ever processed once, tracked in the `processed_events` table.
- **Backs off the moment a human takes over — automatically or manually.**
  If a staff member replies directly in OwnerRez, that's detected and the
  thread pauses itself. Staff can also proactively hit "Pause AI" on any
  conversation from the dashboard's "All Conversations" panel the moment
  they decide to jump in themselves, and "Resume AI" when they're done.

## Why this doesn't need Hello Host's Q&A content

Hello Host most likely works the same way this does: reading OwnerRez's own
property fields rather than a separately authored FAQ. Those fields
(Wi-Fi Password, House Manual, Directions, Check-in Instructions) are
things OwnerRez requires for Airbnb/VRBO listing sync anyway, so if your
listings are live and working, this data mostly already exists — no export
or admin approval needed to get started. Some guest questions (specific
local recommendations, HOA-specific rules) may not be covered by these
fields; those will show up in the "Questions AI Couldn't Answer" gap report
in the dashboard so you know exactly what to add to the House Manual field.

## What this does NOT do yet

- It does not talk to the B2 Maintenance Hub artifact (the claude.ai page)
  — that page's data store is only reachable from inside that page, not
  from an external server. This is a separate, standalone system with its
  own small database and its own bare-bones dashboard. If you want one
  unified system, that's a further step (see bottom of this file).
- The exact JSON shape of OwnerRez's "new message" webhook, the message
  thread response, the property response, and the send-message endpoint
  have none of them been observed by whoever built this — `server.js`
  logs every raw webhook payload to the `webhook_log` table specifically
  so you (or whoever sets this up) can look at real payloads on day one
  and correct the field names in `src/ownerrez.js` / `server.js` if they
  don't match OwnerRez's actual format. Treat every field name in this
  code as a documented best guess, not a confirmed fact, until checked
  against a live response.
- Sending automated replies is genuinely autopilot — no human review step
  before send, by design (per your call that a "review everything" step
  defeats the point). The one guardrail is that the AI is only allowed to
  answer from the verified property/booking facts it's given; it falls
  back to a generic "we'll follow up" reply rather than guessing. Worth
  watching the "Questions AI Couldn't Answer" list closely for the first
  couple of weeks to catch any gaps before they annoy a guest.

## 1. Register an OAuth app in OwnerRez

1. Go to `https://app.ownerrez.com/settings/api`
2. Click **Create App**
3. Name it something like "B2 Maintenance Automation"
4. Set **OAuth Redirect URL** to `https://YOUR-DEPLOYED-URL/oauth/callback`
   (you'll know this URL after step 3 below — you can come back and edit it)
5. Under **Webhooks**, set:
   - **URL**: `https://YOUR-DEPLOYED-URL/webhooks/ownerrez`
   - **User** / **Password**: anything — just make sure these match
     `OWNERREZ_WEBHOOK_USER` / `OWNERREZ_WEBHOOK_PASSWORD` in your `.env`
   - Subscribe to the new-message webhook category (OwnerRez's webhook
     settings list available categories — pick the messaging one)
6. Copy the **Client ID** (`c_...`) and **Client Secret** (`s_...`) —
   the secret is only shown once.

## 2. Get a Claude API key

`https://console.anthropic.com` → API Keys → Create Key. This is billed
separately from your claude.ai subscription — it's pay-as-you-go, and
triaging a short guest message is a tiny, cheap call.

## 3. Deploy

Any Node.js host works. Two easy options with free/cheap tiers:

**Render.com**
1. Push this folder to a GitHub repo (private is fine)
2. Render → New → Web Service → connect the repo
3. Build command: `npm install` — Start command: `npm start`
4. Add all the variables from `.env.example` under Environment
5. **Important**: Render's free tier has an ephemeral filesystem — the
   SQLite file will reset on redeploy/restart. Fine for testing; for real
   use, add a persistent disk (Render supports this on paid plans) or
   swap in Postgres.

**Railway.app** — similar flow, and Railway's volumes persist across
deploys more simply than Render's free tier.

Once deployed, go back to OwnerRez and make sure the OAuth Redirect URL
and Webhook URL actually match your live `https://...` address.

## 4. Connect OwnerRez

Visit `https://YOUR-DEPLOYED-URL/oauth/start` in a browser (it'll ask for
the DASHBOARD_USER/PASSWORD you set) — this sends you to OwnerRez to
approve the app, then redirects back and stores your access/refresh
tokens. Do this once; the app refreshes tokens automatically after that.

## 5. Test it

Test in this order — each step is lower-risk than the next:

1. **AI wiring, zero risk, no OwnerRez needed.** Visit `https://YOUR-DEPLOYED-URL/`, log in with your dashboard credentials, and use the **"Test the full guest AI"** box. It runs the real conversational router against a fake sample property (fake WiFi password, door code, check-in/out time) — nothing here touches OwnerRez or a real guest. Try things like:
   - `what's the wifi password and what time is checkout?` — should answer both from the fake data
   - `the AC isn't working` — should escalate as `maintenance`
   - `can I get a discount, the wifi was down` — should escalate as `billing_admin`, and the reply should NOT promise a discount
   - `the unit was dirty when we got here` — should escalate as `housekeeping`
   - Send a follow-up in the same test thread (don't hit "New Test Conversation") to confirm it remembers what was already said
   - Use the plain **"Test the AI triage manually"** box too — it exercises the older single-shot maintenance categorizer independently, useful for isolating whether an issue is in triage logic vs. the conversational router.
2. **Connect OwnerRez, but test in OwnerRez's own Sandbox first — not real guests.** OwnerRez has a built-in Sandbox Messaging feature (Contacts → pick a guest → "Send as Guest") specifically for testing integrations without involving a real guest. Point your webhook at it and confirm: the webhook arrives, `webhook_log` shows what OwnerRez actually sent (compare against the field-name guesses in `src/ownerrez.js` and correct anything that doesn't match), and a reply appears back in the Sandbox thread.
3. **Only after the Sandbox round-trip looks right, let it run on real threads** — and watch closely for the first few days: check "All Conversations" and "Questions AI Couldn't Answer" in the dashboard regularly, not just when something seems wrong.

- Send yourself a test guest message in OwnerRez (or wait for a real one)
  and check the dashboard, and the `webhook_log` / `guest_qa_log` tables,
  to see what actually came through — then fix up the field names in
  `src/ownerrez.js` (property fields, door codes) and the webhook handler
  in `server.js` to match reality.
- Check the "Questions AI Couldn't Answer" section of the dashboard
  regularly at first — every entry there is either a gap in your OwnerRez
  property fields worth filling in, or a sign the extraction logic needs
  adjusting.

## Local development

```bash
cp .env.example .env    # fill in real values
npm install
npm start                # http://localhost:3000
```

For OwnerRez to reach your machine locally, you'll need a tunnel (ngrok,
Cloudflare Tunnel) so it has a public URL to send webhooks to.

## Unifying with the Maintenance Hub artifact later

If eventually you want ONE system instead of two, the cleanest path is
to rebuild the Maintenance Hub's frontend as a page served BY this same
backend (instead of a claude.ai published artifact) — then everything
(webhook-created orders, manually created orders, the parts/cost
calculator) lives in one database. That's a bigger follow-up project,
not a quick patch — happy to help plan it out when you're ready.
