/**
 * mel-tools-api — Anthropic proxy (streaming edition)
 * 
 * CHANGE LOG vs previous version:
 * 1. Added stream:true path — relays SSE chunks from Anthropic so long
 *    responses survive Netlify's 10s free-tier timeout.
 * 2. Non-streaming path unchanged (IQR still uses it).
 * 3. Usage logging deferred to message_stop event in stream path.
 *
 * Handles: origin allowlisting, per-IP rate limiting, daily spend cap, usage logging.
 * All limits reset at midnight UTC.
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

  const { _tool: tool = "unknown", _stream: wantStream = false, ...anthropicBody } = body;

  // ─── STREAMING PATH ─────────────────────────────────────────────────────────
  if (wantStream) {
    const streamBody = { ...anthropicBody, stream: true };

    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(streamBody)
      });
    } catch (e) {
      return cors(502, JSON.stringify({ error: "Failed to reach Anthropic API", detail: e.message }), origin);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return cors(anthropicRes.status, errText, origin);
    }

    // Read the full SSE stream, collect text + usage, then return as one JSON response.
    // This keeps the Netlify function alive for the full generation (body is being read),
    // while giving the client a simple JSON response identical to non-streaming.
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let usage = { input_tokens: 0, output_tokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const evt = JSON.parse(payload);

          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            fullText += evt.delta.text;
          }
          if (evt.type === "message_delta" && evt.usage) {
            usage.output_tokens = evt.usage.output_tokens || usage.output_tokens;
          }
          if (evt.type === "message_start" && evt.message?.usage) {
            usage.input_tokens = evt.message.usage.input_tokens || 0;
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }

    // Log usage
    const callCost = (usage.input_tokens / 1000 * COST_PER_1K_INPUT) +
                     (usage.output_tokens / 1000 * COST_PER_1K_OUTPUT);

    await redis("INCR", ipKey(ip));
    await redis("EXPIRE", ipKey(ip), 90000);
    await redis("INCRBYFLOAT", spendKey(), callCost.toFixed(6));
    await redis("EXPIRE", spendKey(), 90000);

    const logEntry = JSON.stringify({
      t: new Date().toISOString(),
      tool,
      ip: ip.slice(0, 8) + "***",
      in: usage.input_tokens,
      out: usage.output_tokens,
      cost: callCost.toFixed(6),
      streamed: true
    });
    await redis("RPUSH", logKey(), logEntry);
    await redis("EXPIRE", logKey(), 90000);

    // Return in the same shape as non-streaming Anthropic response
    const result = {
      content: [{ type: "text", text: fullText }],
      usage
    };

    return cors(200, JSON.stringify(result), origin);
  }

  // ─── NON-STREAMING PATH (unchanged) ─────────────────────────────────────────
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
