"use strict";

const fetch = require("node-fetch");

const CATEGORIES = [
  { id: "wifi", label: "WiFi / Internet", defaultAssignee: "Alex Velazquez (IT Support)" },
  { id: "tv_electronics", label: "TV / Electronics", defaultAssignee: "Robert Pander (Maintenance Tech)" },
  { id: "hvac", label: "HVAC", defaultAssignee: "Todd Powers (Head of Maintenance)" },
  { id: "plumbing", label: "Plumbing", defaultAssignee: "Todd Powers (Head of Maintenance)" },
  { id: "appliance", label: "Appliance", defaultAssignee: "Robert Pander (Maintenance Tech)" },
  { id: "key_lock_access", label: "Key / Lock / Access", defaultAssignee: "Robert Pander (Maintenance Tech)" },
  { id: "pool_hot_tub", label: "Pool / Hot Tub", defaultAssignee: "Todd Powers (Head of Maintenance)" },
  { id: "cleaning", label: "Cleaning Issue", defaultAssignee: "Cleaning Provider" },
  { id: "exterior_structural", label: "Exterior / Structural", defaultAssignee: "Todd Powers (Head of Maintenance)" },
  { id: "other", label: "Other", defaultAssignee: "Tracy Leonard (Office Manager)" }
];

function defaultAssigneeFor(categoryId) {
  const c = CATEGORIES.find((x) => x.id === categoryId);
  return c ? c.defaultAssignee : "Unassigned";
}

function buildPrompt(property, message) {
  const catList = CATEGORIES.map((c) => c.id).join("|");
  return (
    "You are triaging an incoming maintenance/issue report for a short-term rental company in Myrtle Beach, SC. " +
    "Read the report and reply with ONLY a JSON object, no other text, in this exact shape:\n" +
    `{"category":"${catList}","priority":"emergency|high|routine","title":"short 6-8 word title","description":"1-2 sentence clean, professional summary of what needs to be done"}\n\n` +
    'Guidance: "emergency" = no heat/AC in extreme weather, water leak/flooding, no working lock/security issue, gas smell, or anything unsafe. ' +
    '"high" = guest currently affected and waiting (WiFi down, TV down, appliance broken) but not unsafe. "routine" = cosmetic, non-urgent, or can wait for next visit.\n\n' +
    `Property/unit: "${property || "unknown"}"\n` +
    `Report: "${message}"`
  );
}

async function triageMessage(property, message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: buildPrompt(property, message) }]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude API returned no text content.");

  let parsed;
  try {
    // Tolerant parse: whole reply, or the first {...} block within it.
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Could not parse JSON from Claude's response: " + textBlock.text);
    parsed = JSON.parse(match[0]);
  }

  const category = CATEGORIES.some((c) => c.id === parsed.category) ? parsed.category : "other";
  const priority = ["emergency", "high", "routine"].includes(parsed.priority) ? parsed.priority : "routine";

  return {
    category,
    priority,
    title: parsed.title || `${category} issue — ${property || "unknown property"}`,
    description: parsed.description || message,
    assignee: defaultAssigneeFor(category)
  };
}

module.exports = { triageMessage, CATEGORIES, defaultAssigneeFor };
