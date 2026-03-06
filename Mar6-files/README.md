# mel-tools-api

Netlify serverless proxy for [belltawnb.github.io](https://belltawnb.github.io) MEL tools.  
Holds the Anthropic API key server-side, enforces rate limits, and logs daily usage.

## Features

- Per-IP daily request limit (20 requests/day)
- Daily spend cap ($5/day soft limit)
- Usage logging via Upstash Redis
- Daily email summary of tool usage
- All limits reset at midnight UTC

## Self-hosting

Want to use these tools with your own API key? Fork this repo and deploy to your own Netlify account.

### Environment variables required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `SUMMARY_EMAIL` | Email address for daily summary |
| `SENDGRID_API_KEY` | SendGrid API key (free tier is fine) |

### Deploy steps

1. Fork this repo
2. Create a free [Netlify](https://netlify.com) account
3. Connect your fork to Netlify
4. Add the environment variables above in Netlify → Site Settings → Environment Variables
5. Create a free [Upstash](https://upstash.com) Redis database
6. Create a free [SendGrid](https://sendgrid.com) account and verify your sender email
7. Deploy

### Adjusting limits

Edit the constants at the top of `netlify/functions/proxy.js`:

```js
const DAILY_IP_LIMIT = 20;   // requests per IP per day
const DAILY_SPEND_CAP = 5.00; // USD per day
```

## Tool endpoint

All tools POST to:
```
https://your-netlify-site.netlify.app/api/proxy
```

Include a `_tool` field in your request body to identify which tool is making the call (used in usage logs):
```json
{
  "_tool": "indicator-quality-reviewer",
  "model": "claude-sonnet-4-6",
  "max_tokens": 2500,
  "messages": [...]
}
