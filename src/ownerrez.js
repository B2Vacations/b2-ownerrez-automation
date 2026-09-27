// Minimal OwnerRez OAuth2 + API v2.0 client.
// Docs: https://www.ownerrez.com/support/articles (API & Webhooks sections)
"use strict";

const fetch = require("node-fetch");
const db = require("./db");

const OR_BASE = "https://api.ownerrez.com/v2";
const OR_TOKEN_URL = "https://app.ownerrez.com/oauth2/token";
const OR_AUTHORIZE_URL = "https://app.ownerrez.com/oauth2/authorize";

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.OWNERREZ_CLIENT_ID,
    redirect_uri: process.env.OWNERREZ_REDIRECT_URI,
    response_type: "code",
    // Adjust scopes to only what you actually need once you've confirmed
    // exact scope names in your OwnerRez app settings — this is a starting set.
    scope: "messages bookings properties",
    state: state || "b2"
  });
  return `${OR_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(OR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: process.env.OWNERREZ_CLIENT_ID,
      client_secret: process.env.OWNERREZ_CLIENT_SECRET,
      redirect_uri: process.env.OWNERREZ_REDIRECT_URI
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OwnerRez token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  saveTokens(data);
  return data;
}

async function refreshAccessToken() {
  const row = db.getSetting("ownerrez_tokens");
  if (!row) throw new Error("No OwnerRez tokens stored yet — connect the app first via /oauth/start.");
  const tokens = JSON.parse(row);
  const res = await fetch(OR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.OWNERREZ_CLIENT_ID,
      client_secret: process.env.OWNERREZ_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OwnerRez token refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  saveTokens(data);
  return data;
}

function saveTokens(data) {
  const record = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    obtained_at: Date.now(),
    expires_in: data.expires_in || 3600
  };
  db.setSetting("ownerrez_tokens", JSON.stringify(record));
}

function getStoredTokens() {
  const row = db.getSetting("ownerrez_tokens");
  return row ? JSON.parse(row) : null;
}

async function getValidAccessToken() {
  const tokens = getStoredTokens();
  if (!tokens) throw new Error("OwnerRez isn't connected yet. Visit /oauth/start to connect.");
  const ageMs = Date.now() - tokens.obtained_at;
  const expiresMs = (tokens.expires_in - 60) * 1000; // refresh 60s early
  if (ageMs > expiresMs) {
    const fresh = await refreshAccessToken();
    return fresh.access_token;
  }
  return tokens.access_token;
}

async function apiGet(path) {
  const token = await getValidAccessToken();
  const res = await fetch(`${OR_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OwnerRez API GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Fetch a message thread by id. Confirm the exact endpoint shape against
// OwnerRez's current API reference before relying on this in production —
// path/response fields can differ from this draft.
async function getMessageThread(threadId) {
  return apiGet(`/messages/${threadId}`);
}

async function getBooking(bookingId) {
  return apiGet(`/bookings/${bookingId}`);
}

async function getProperty(propertyId) {
  return apiGet(`/properties/${propertyId}`);
}

// Lists all properties on the account, paging through results. OwnerRez's
// list endpoints are commonly paginated with page/page_size-style params —
// confirm the exact query param names and response envelope (items vs
// results vs data) against a real call once connected, and adjust below.
async function listAllProperties() {
  const all = [];
  let page = 1;
  const pageSize = 100;
  // Safety cap so a misbehaving pagination loop can't run forever.
  for (let i = 0; i < 50; i++) {
    const res = await apiGet(`/properties?page=${page}&page_size=${pageSize}`);
    const items = res.items || res.results || res.data || (Array.isArray(res) ? res : []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < pageSize) break;
    page++;
  }
  return all;
}

// Pulls the guest-facing fields confirmed to exist on an OwnerRez property
// (per OwnerRez's own "Channel Management API Integrations — Property Field
// Differences" doc): Wi-Fi Password, House Manual, Bedroom/Bathroom Details,
// plus Directions and Check-in Instructions from the Guest Instructions tab.
// The exact JSON key names below are a reasonable guess based on the field
// LABELS OwnerRez documents — verify against one real /properties/{id}
// response once connected, and correct the key names here if they differ.
async function getPropertyGuestInfo(propertyId) {
  const p = await getProperty(propertyId);
  return {
    id: propertyId,
    name: p.name || p.property_name || `Property #${propertyId}`,
    wifiNetwork: p.wifi_network || p.wifi_ssid || null,
    wifiPassword: p.wifi_password || null,
    houseManual: p.house_manual || null,
    directions: p.directions || null,
    checkinInstructions: p.checkin_instructions || p.check_in_instructions || null,
    bedroomDetails: p.bedroom_details || null,
    bathroomDetails: p.bathroom_details || null
  };
}

// Door codes live on the BOOKING, not the property (per OwnerRez's Zapier
// docs: bookings carry a door_codes array of {code, lock_names}). A guest's
// message thread should be tied to a booking id — confirm that link once a
// real webhook/thread payload has been seen.
async function getBookingDoorCodes(bookingId) {
  const b = await getBooking(bookingId);
  const codes = b.door_codes || [];
  return codes.map((c) => ({ code: c.code, lockNames: c.lock_names || c.lockNames || [] }));
}

// Check-in/checkout are booking-level facts, not property-level — pulled
// separately so the guest QA prompt can answer "what time is checkout"
// correctly. Field names are a best guess from OwnerRez's general booking
// model — verify against a real /bookings/{id} response once connected.
async function getBookingStayInfo(bookingId) {
  const b = await getBooking(bookingId);
  return {
    checkinDateTime: b.arrival || b.check_in || b.arrival_date || null,
    checkoutDateTime: b.departure || b.check_out || b.departure_date || null
  };
}

// Sends a reply into an existing OwnerRez message thread.
// OwnerRez's Messaging API exists (confirmed via their API docs) but the
// exact endpoint path and payload shape for THIS build have not been
// observed against a live account yet — verify and correct before relying
// on this to actually send guest-facing messages.
async function sendMessage(threadId, body) {
  const token = await getValidAccessToken();
  const res = await fetch(`${OR_BASE}/messages/${threadId}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OwnerRez send-message failed (${res.status}): ${text}`);
  }
  return res.json();
}

module.exports = {
  authorizeUrl,
  exchangeCodeForToken,
  getValidAccessToken,
  getMessageThread,
  getBooking,
  getProperty,
  listAllProperties,
  getPropertyGuestInfo,
  getBookingDoorCodes,
  getBookingStayInfo,
  sendMessage
};
