# Security Policy

## Scope

This repo contains a Netlify serverless proxy (`netlify/functions/proxy.js`) that forwards requests to the Anthropic API on behalf of users of [belltawnb.github.io](https://belltawnb.github.io) MEL tools.

## Supported Versions

Only the current `main` branch is actively maintained.

## Security Design

- **API key**: The Anthropic API key is stored as a Netlify environment variable and never exposed in the codebase or to clients.
- **Origin allowlisting**: The proxy only accepts requests from `https://belltawnb.github.io`. Requests from other origins are rejected with a 403 before any processing occurs.
- **Rate limiting**: Per-IP daily request limits and a daily spend cap are enforced via Upstash Redis to prevent abuse.
- **Logging**: Usage metadata (timestamp, tool name, masked IP fragment, token counts, estimated cost) is stored in Upstash Redis for 25 hours, then automatically deleted. No user-submitted content is logged.

## Reporting a Vulnerability

If you find a security issue in this repo, please do not open a public GitHub issue.

Email: [set in Netlify env vars]  
Subject line: `[SECURITY] mel-tools-api`

Include a description of the issue and steps to reproduce. I'll respond within 5 business days. If the issue is confirmed, I'll address it as quickly as possible and credit you if you'd like.

## Known Limitations

CORS origin allowlisting stops browser-based abuse from other sites but does not prevent direct server-to-server calls to the proxy endpoint. The daily spend cap ($5/day) and per-IP rate limit (20 requests/day) are the primary controls against non-browser abuse.
