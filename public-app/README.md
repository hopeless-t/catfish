# CATFISH Public

Public MCP surface for CATFISH. It intentionally exposes only the low-risk read-only capability plane:

- `catfish_search` — web search with provider fallback
- `catfish_fetch` — public URL → compact text
- `catfish_about` — capability and safety boundary

The local CATFISH edition keeps browser sessions, persistent profiles, JavaScript eval, and CDP access on the user's machine. Those capabilities are **not** exposed by this public service.

## Local development

```bash
npm install
npm run dev
```

The HTTP MCP endpoint is provided by `xmcp`.

## Security

Fetch rejects localhost and private/link-local/reserved network targets, validates redirect destinations, limits redirect depth, caps response bytes, and times out network calls.
