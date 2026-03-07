/**
 * mel-tools-api — Anthropic proxy
 * Handles: origin allowlisting, per-IP rate limiting, daily spend cap, usage logging
 * All limits reset at midnight UTC
 */

const DAILY_IP_LIMIT = 20;
const DAILY_SPEND_CAP = 5.00;

const COST_PER_1K_INPUT  = 0.000003;
const COST_PER_1K_OUTPUT = 0.000015;

const ALLOWED_ORIGINS = new Set([
  "https://belltawnb.github.io",
  "http://localhost:8888",
  "http://localhost:3000"
]);

async function redis(command, ...args) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const json = await res.json();
  return json.result;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function ipKey(ip)  { return `ip:${ip}:${todayKey()}`; }
function spendKey() { return `spend:${todayKey()}`; }
function logKey()   { return `log:${todayKey()}`; }

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const originAllowed = ALLOWED_ORIGINS.has(origin);

  // Reject disallowed origins before doing anything else
  if (!originAllowed) {
    return {
      statusCode: 403,
      headers: {
        "Access-Control-Allow-Origin": "null",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ error: "Forbidden origin" })
    };
  }

  if (event.httpMethod === "OPTIONS") return cors(200, "", origin);
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ error: "Method not allowed" }), origin);

  const ip =
    event.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    event.headers["client-ip"] ||
    "unknown";

  // Per-IP limit
  const ipCount = parseInt((await redis("GET", ipKey(ip))) || "0", 10);
  if (ipCount >= DAILY_IP_LIMIT) {
    return cors(429, JSON.stringify({
      error: "rate_limited",
      message: `You've reached the daily limit of ${DAILY_IP_LIMIT} requests. Try again in 24 hours, or download the code from GitHub to use your own API key.`
    }), origin);
  }

  // Daily spend cap
  const currentSpend = parseFloat((await redis("GET", spendKey())) || "0");
  if (currentSpend >= DAILY_SPEND_CAP) {
    return cors(429, JSON.stringify({
      error: "spend_cap",
      message: "Daily usage limit reached. Try again tomorrow, or download the code from GitHub to use your own API key."
    }), origin);
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return cors(400, JSON.stringify({ error: "Invalid JSON body" }), origin);
  }

  // Strip internal _tool field before forwarding to Anthropic
  const { _tool: tool = "unknown", ...anthropicBody } = body;

  // Forward to Anthropic
  let anthropicRes, anthropicJson;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicBody)
    });
    anthropicJson = await anthropicRes.json();
  } catch (e) {
    return cors(502, JSON.stringify({ error: "Failed to reach Anthropic API", detail: e.message }), origin);
  }

  // Log usage + update counters
  if (anthropicRes.ok && anthropicJson.usage) {
    const { input_tokens = 0, output_tokens = 0 } = anthropicJson.usage;
    const callCost = (input_tokens / 1000 * COST_PER_1K_INPUT) +
                     (output_tokens / 1000 * COST_PER_1K_OUTPUT);

    await redis("INCR", ipKey(ip));
    await redis("EXPIRE", ipKey(ip), 90000);
    await redis("INCRBYFLOAT", spendKey(), callCost.toFixed(6));
    await redis("EXPIRE", spendKey(), 90000);

    const logEntry = JSON.stringify({
      t: new Date().toISOString(),
      tool,
      ip: ip.slice(0, 8) + "***",
      in: input_tokens,
      out: output_tokens,
      cost: callCost.toFixed(6)
    });
    await redis("RPUSH", logKey(), logEntry);
    await redis("EXPIRE", logKey(), 90000);
  }

  return cors(anthropicRes.status, JSON.stringify(anthropicJson), origin);
};

function cors(status, body, origin) {
  return {
    statusCode: status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body
  };
}
