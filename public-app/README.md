# CATFISH Public

> Search when you must. Fetch only what you need.

CATFISH Public is the read-only internet-facing edition of CATFISH.

It exists for agents that need public web information but do **not** need a full browser session for every task.

Public MCP endpoint:

```text
https://catfish-public.vercel.app/mcp
```

## Tools

- `catfish_search` — find public web pages with provider fallback
- `catfish_fetch` — turn a public URL into compact agent-friendly text
- `catfish_about` — describe capabilities and the safety boundary

The intended routing is:

```text
known URL -> fetch -> done
unknown URL -> search -> fetch only relevant pages -> done
```

The local CATFISH edition adds browser sessions, persistent profiles, JavaScript eval, and CDP. Those capabilities are intentionally **not** exposed here.

## Why read-only?

A public service that can click buttons, reuse logged-in profiles, execute arbitrary page JavaScript, or expose CDP has a very different risk profile from a search/fetch service.

CATFISH keeps that boundary explicit:

- public = discovery + reading
- local = interaction + browser control

## Security

Fetch rejects localhost and private/link-local/reserved network targets, validates redirect destinations, limits redirect depth, caps response bytes, and times out network calls.

CATFISH Public is not designed to bypass CAPTCHA, authentication, paywalls, or site access controls.

## Local development

```bash
npm install
npm run dev
```

The HTTP MCP endpoint is provided by `xmcp`.

For the project philosophy, local browser edition, and architecture, see the repository root README.
