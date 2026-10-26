# CATFISH

飼い主謹製 TinyFish 的 Web Worker。TinyFish のサービスを複製するのではなく、既存の `agent-browser` / Chrome を execution substrate として再利用し、薄い control plane だけを自作する。

## v0.1 capability graph

- **Search fast-path**: Brave HTML -> normalized links, verifier failure -> Bing fallback.
- **Fetch fast-path**: URL -> `agent-browser read` -> clean text. LLM / persistent browser 不要。
- **Browser**: isolated named session -> open / snapshot / click / fill / type / press / get / scroll / screenshot.
- **Agent slow-path**: browser session + `agent-browser chat`. 本当に曖昧な操作だけモデルへ渡す。
- **Evidence**: run ごとに `runs/<run-id>/events.jsonl`、screenshot は同ディレクトリ。
- **Auth**: credential を API や prompt に埋めず `agent-browser` の profile/auth vault を利用。
- **Safety boundary**: default では localhost/private IP への URL fetch を拒否。必要なら `CATFISH_ALLOW_PRIVATE=1`。

## Start

```bash
cd ~/catfish
python3 -m catfish.server
```

## Examples

```bash
curl -s http://127.0.0.1:28765/health

curl -s http://127.0.0.1:28765/v1/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

curl -s http://127.0.0.1:28765/v1/browser/open \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

The browser/open response returns a session id. Reuse it with `/v1/browser/action`.

```json
{"session":"cf-...","action":"snapshot"}
{"session":"cf-...","action":"click","selector":"@e1"}
{"session":"cf-...","action":"fill","selector":"@e2","text":"hello"}
{"session":"cf-...","action":"get","what":"url"}
```

## Design principle

`search/fetch -> deterministic actions -> agent` の順に昇格する。最初から全ページを vision+LLM に食わせない。高価で壊れやすい仕事を必要になるまで発生させない。

## Next

1. Search adapter (browser-rendered search + structured result normalization)
2. DOM/action loop with verifier, retry, and completion predicate
3. persistent profile leases + vault mapping
4. run replay / HAR / video optional capture
5. MCP server + OpenAI/Claude/Codex tool schema
6. worker pool / remote Chrome node / Cloudflare-GCP transport

## MCP

CATFISH はモデルを内蔵しない。MCP client (ChatGPT/Codex/Claude/任意の worker) が planner になり、CATFISH は deterministic executor になる。

```bash
# in a venv with the mcp package
python -m catfish.mcp_server
```

Exposed tools: `catfish_search`, `catfish_fetch`, `catfish_browser_open`, `catfish_browser_action`, `catfish_browser_close`.

## v0.2 failure policy

- Search: Brave -> verifier -> Bing fallback. Search providers are adapters, not architecture.
- Safe/idempotent reads may retry automatically.
- Mutating browser actions (click/fill/type/press) are **never auto-replayed**; duplicate submission is treated as worse than a surfaced failure.
- Search/fetch/open results expose attempts and verifier warnings so the caller can repair policy from evidence.

## v0.3 browser sessions

`browser_open` can take a safe profile name. CATFISH maps it under `~/catfish/profiles/`; callers cannot supply arbitrary profile paths. A profile persists cookies/localStorage across sessions and is leased to one active session at a time.

Open responses include `cdp_url`, a loopback WebSocket endpoint for direct Playwright/Puppeteer/CDP use. `catfish_browser_session` returns title/url/profile/cdp_url. The HTTP service intentionally binds `127.0.0.1`; do not expose it publicly without a real auth/TLS boundary because CDP is full browser control.

`browser_action` also supports `eval` for page-context JavaScript. Mutating actions remain non-retrying.
