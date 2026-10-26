from __future__ import annotations
import os
from .server import search, fetch, browser_open, browser_session_info, browser_action, browser_close, run_id, session_id

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as e:
    raise SystemExit("CATFISH MCP needs the Python 'mcp' package. Install with: pip install 'mcp[cli]'") from e

mcp = FastMCP(
    "CATFISH",
    instructions=(
        "Self-hosted deterministic web worker. Prefer catfish_search to discover URLs, "
        "catfish_fetch to read them, and escalate to browser_open + browser_action only "
        "when interaction/state is required. Reuse sessions and close them when finished."
    ),
)
mcp._mcp_server.version = "0.3.0"

@mcp.tool()
def catfish_search(query: str, limit: int = 8) -> dict:
    """Search the public web. Uses provider fallback and returns normalized title/url results."""
    return search(query, run_id(), limit)

@mcp.tool()
def catfish_fetch(url: str) -> dict:
    """Fetch a public HTTP(S) URL and return agent-readable page text using the fast path."""
    return fetch(url, run_id())

@mcp.tool()
def catfish_browser_open(url: str, session: str | None = None, profile: str | None = None) -> dict:
    """Open a public HTTP(S) URL in an isolated browser session. Optional profile persists cookies/storage. Returns a local CDP URL."""
    s = session or session_id()
    return browser_open(url, s, run_id(), profile)

@mcp.tool()
def catfish_browser_session(session: str) -> dict:
    """Return current title, URL, profile lease, and local CDP WebSocket URL for a browser session."""
    return browser_session_info(session, run_id())

@mcp.tool()
def catfish_browser_action(
    session: str,
    action: str,
    selector: str | None = None,
    text: str | None = None,
    key: str | None = None,
    what: str | None = None,
    direction: str | None = None,
    pixels: int | None = None,
    target: str | int | None = None,
    script: str | None = None,
    compact: bool = True,
) -> dict:
    """Act in a CATFISH browser session. Actions: snapshot, click, fill, type, press, get, wait, scroll, back, forward, reload, screenshot, eval."""
    body = {"session": session, "action": action, "compact": compact}
    for k, v in {
        "selector": selector,
        "text": text,
        "key": key,
        "what": what,
        "direction": direction,
        "pixels": pixels,
        "target": target,
        "script": script,
    }.items():
        if v is not None:
            body[k] = v
    return browser_action(session, body, run_id())

@mcp.tool()
def catfish_browser_close(session: str) -> dict:
    """Close a CATFISH browser session."""
    return browser_close(session, run_id())


def main():
    mcp.run(transport=os.environ.get("CATFISH_MCP_TRANSPORT", "stdio"))


if __name__ == "__main__":
    main()
