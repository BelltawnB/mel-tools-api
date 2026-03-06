/**
 * mel-tools-api — Anthropic proxy
 * Handles: per-IP rate limiting, daily spend cap, usage logging
 * All limits reset at midnight UTC
 */

const DAILY_IP_LIMIT = 20;          // requests per IP per day
const DAILY_SPEND_CAP = 5.00;       // USD — soft cap, resets midnight UTC
const ALLOWED_ORIGIN = "https://belltawnb.github.io";

// Approximate cost per 1k tokens (claude-sonnet-4 input/output blended estimate)
// Update if Anthropic changes pricing
const COST_PER_1K_INPUT  = 0.000003;   // $3 per 1M input tokens
const COST_PER_1K_OUTPUT = 0.000015;   // $15 per 1M output tokens

// ── Upstash Redis helpers (REST API, no SDK needed) ──────────────────────────
async function redis(command, ...args) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const json = await res.json();
  return json.result;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-03-06"
}

function ipKey(ip)    { return `ip:${ip}:${todayKey()}`; }
function spendKey()   { return `spend:${todayKey()}`; }
function logKey()     { return `log:${todayKey()}`; }

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return cors(200, "", origin);
  }

  if (event.httpMethod !== "POST") {
    return cors(405, JSON.stringify({ error: "Method not allowed" }), origin);
  }

  // Get client IP
  const ip =
    event.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    event.headers["client-ip"] ||
    "unknown";

  // ── Check per-IP limit ───────────────────────────────────────────────────
  const ipCount = parseInt((await redis("GET", ipKey(ip))) || "0", 10);
  if (ipCount >= DAILY_IP_LIMIT) {
    return cors(429, JSON.stringify({
      error: "rate_limited",
      message: `You've reached the daily limit of ${DAILY_IP_LIMIT} requests. Try again in 24 hours.`
    }), origin);
  }

  // ── Check daily spend cap ────────────────────────────────────────────────
  const currentSpend = parseFloat((await redis("GET", spendKey())) || "0");
  if (currentSpend >= DAILY_SPEND_CAP) {
    return cors(429, JSON.stringify({
      error: "spend_cap",
      message: "Daily usage limit reached. Try again tomorrow, or download the code from GitHub to use your own API key."
    }), origin);
  }

  // ── Forward to Anthropic ─────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return cors(400, JSON.stringify({ error: "Invalid JSON body" }), origin);
  }

  let anthropicRes, anthropicJson;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
    anthropicJson = await anthropicRes.json();
  } catch (e) {
    return cors(502, JSON.stringify({ error: "Failed to reach Anthropic API", detail: e.message }), origin);
  }

  // ── Log usage + update counters ──────────────────────────────────────────
  if (anthropicRes.ok && anthropicJson.usage) {
    const { input_tokens = 0, output_tokens = 0 } = anthropicJson.usage;
    const callCost = (input_tokens / 1000 * COST_PER_1K_INPUT) +
                     (output_tokens / 1000 * COST_PER_1K_OUTPUT);

    // Increment IP counter (expires in 25h to ensure daily reset)
    await redis("INCR", ipKey(ip));
    await redis("EXPIRE", ipKey(ip), 90000);

    // Add to daily spend (keep 25h)
    await redis("INCRBYFLOAT", spendKey(), callCost.toFixed(6));
    await redis("EXPIRE", spendKey(), 90000);

    // Append to daily log (tool name, ip hash, tokens, cost)
    const tool = body._tool || "unknown";
    const logEntry = JSON.stringify({
      t: new Date().toISOString(),
      tool,
      ip: ip.slice(0, 8) + "***",   // partial IP for privacy
      in: input_tokens,
      out: output_tokens,
      cost: callCost.toFixed(6)
    });
    await redis("RPUSH", logKey(), logEntry);
    await redis("EXPIRE", logKey(), 90000);
  }

  return cors(
    anthropicRes.status,
    JSON.stringify(anthropicJson),
    origin
  );
};

function cors(status, body, origin) {
  return {
    statusCode: status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body
  };
}
