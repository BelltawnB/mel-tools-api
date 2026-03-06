/**
 * daily-summary — runs at 7am UTC every day
 * Reads yesterday's usage from Upstash Redis and emails a summary
 *
 * Requires env vars:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   SUMMARY_EMAIL        — your email address
 *   SENDGRID_API_KEY     — free SendGrid account (100 emails/day free)
 */

async function redis(command, ...args) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const json = await res.json();
  return json.result;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

exports.handler = async () => {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const day = dateKey(yesterday);

  // Read yesterday's data
  const spend   = parseFloat((await redis("GET", `spend:${day}`)) || "0");
  const logRaw  = await redis("LRANGE", `log:${day}`, "0", "-1") || [];

  const logs = logRaw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Aggregate by tool
  const byTool = {};
  for (const l of logs) {
    if (!byTool[l.tool]) byTool[l.tool] = { calls: 0, cost: 0 };
    byTool[l.tool].calls++;
    byTool[l.tool].cost += parseFloat(l.cost);
  }

  const toolRows = Object.entries(byTool)
    .map(([tool, d]) => `<tr><td>${tool}</td><td>${d.calls}</td><td>$${d.cost.toFixed(4)}</td></tr>`)
    .join("") || "<tr><td colspan='3'>No usage</td></tr>";

  const html = `
    <h2>MEL Tools — Daily Usage Summary</h2>
    <p><strong>Date:</strong> ${day}</p>
    <p><strong>Total spend:</strong> $${spend.toFixed(4)} / $5.00 cap</p>
    <p><strong>Total requests:</strong> ${logs.length}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <thead><tr><th>Tool</th><th>Calls</th><th>Cost</th></tr></thead>
      <tbody>${toolRows}</tbody>
    </table>
    <p style="color:#999;font-size:12px">Sent by mel-tools-api · belltawnb.github.io</p>
  `;

  // Send via SendGrid
  await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.SUMMARY_EMAIL }] }],
      from: { email: process.env.SUMMARY_EMAIL, name: "MEL Tools" },
      subject: `MEL Tools Usage — ${day}`,
      content: [{ type: "text/html", value: html }]
    })
  });

  return { statusCode: 200, body: "Summary sent" };
};
