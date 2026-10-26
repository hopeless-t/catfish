#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import subprocess
import time
import uuid
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"
PROFILES = ROOT / "profiles"
PROFILE_LEASES: dict[str, str] = {}
AB = os.environ.get("CATFISH_AGENT_BROWSER", "agent-browser")
CURL = os.environ.get("CATFISH_CURL", "curl")
DEFAULT_TIMEOUT = int(os.environ.get("CATFISH_TIMEOUT", "30"))
ALLOW_PRIVATE = os.environ.get("CATFISH_ALLOW_PRIVATE", "0") == "1"
MAX_BODY = 1_000_000
MAX_SEARCH_HTML = 2_000_000
SESSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
PROFILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
BLOCK_MARKERS = (
    "verify you are human",
    "confirm this search was made by a human",
    "unusual traffic",
    "captcha",
    "access denied",
    "too many requests",
)


def now_ms():
    return int(time.time() * 1000)


def run_id():
    return time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]


def session_id():
    return "cf-" + uuid.uuid4().hex[:12]


def log_event(rid: str, event: dict):
    d = RUNS / rid
    d.mkdir(parents=True, exist_ok=True)
    event = {"ts_ms": now_ms(), **event}
    with (d / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def valid_session(s: str) -> bool:
    return bool(SESSION_RE.fullmatch(s or ""))


def profile_path(name: str) -> Path:
    if not PROFILE_RE.fullmatch(name or ""):
        raise ValueError("invalid profile name")
    p = PROFILES / name
    p.mkdir(parents=True, exist_ok=True)
    return p

def acquire_profile(name: str, session: str):
    current = PROFILE_LEASES.get(name)
    if current and current != session:
        raise ValueError(f"profile already leased by session: {current}")
    PROFILE_LEASES[name] = session

def release_profile_for_session(session: str):
    for name, owner in list(PROFILE_LEASES.items()):
        if owner == session:
            PROFILE_LEASES.pop(name, None)


def validate_url(url: str):
    p = urlparse(url)
    if p.scheme not in {"http", "https"} or not p.hostname:
        raise ValueError("only http/https URLs are allowed")
    if ALLOW_PRIVATE:
        return
    host = p.hostname
    if host in {"localhost", "localhost.localdomain"}:
        raise ValueError("private/local addresses are disabled")
    try:
        for info in socket.getaddrinfo(
            host,
            p.port or (443 if p.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        ):
            ip = ipaddress.ip_address(info[4][0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
            ):
                raise ValueError("private/local addresses are disabled")
    except socket.gaierror as e:
        raise ValueError(f"DNS resolution failed: {e}")


def _sleep_retry(attempt: int):
    time.sleep(min(0.15 * (2**attempt), 0.8))


def exec_ab(args: list[str], timeout=DEFAULT_TIMEOUT, retries: int = 0):
    attempts = []
    for attempt in range(retries + 1):
        t0 = time.perf_counter()
        try:
            p = subprocess.run(
                [AB, *args], text=True, capture_output=True, timeout=timeout
            )
            row = {
                "ok": p.returncode == 0,
                "exit_code": p.returncode,
                "stdout": p.stdout,
                "stderr": p.stderr,
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        except subprocess.TimeoutExpired as e:
            row = {
                "ok": False,
                "exit_code": 124,
                "stdout": e.stdout or "",
                "stderr": e.stderr or "backend timeout",
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        attempts.append(row)
        if row["ok"]:
            break
        if attempt < retries:
            _sleep_retry(attempt)
    out = dict(attempts[-1])
    out["attempts"] = len(attempts)
    return out


def exec_curl(url: str, timeout=12, retries: int = 1):
    attempts = []
    for attempt in range(retries + 1):
        t0 = time.perf_counter()
        try:
            p = subprocess.run(
                [
                    CURL,
                    "-L",
                    "--fail-with-body",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    str(timeout),
                    "--max-filesize",
                    str(MAX_SEARCH_HTML),
                    "-H",
                    "Accept-Encoding: identity",
                    "-A",
                    "Mozilla/5.0",
                    url,
                ],
                capture_output=True,
                timeout=timeout + 3,
            )
            body = p.stdout[:MAX_SEARCH_HTML].decode("utf-8", errors="replace")
            err = p.stderr.decode("utf-8", errors="replace")
            row = {
                "ok": p.returncode == 0,
                "exit_code": p.returncode,
                "body": body,
                "stderr": err,
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        except subprocess.TimeoutExpired:
            row = {
                "ok": False,
                "exit_code": 124,
                "body": "",
                "stderr": "curl timeout",
                "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        attempts.append(row)
        if row["ok"]:
            break
        if attempt < retries:
            _sleep_retry(attempt)
    out = dict(attempts[-1])
    out["attempts"] = len(attempts)
    return out


def verify_text(text: str):
    low = text.lower()
    warnings = [f"block-marker:{m}" for m in BLOCK_MARKERS if m in low]
    if not text.strip():
        warnings.append("empty-content")
    return {"verified": not warnings, "warnings": warnings}


class AnchorParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.anchors = []

    def handle_starttag(self, tag, attrs):
        if tag != "a" or self.current is not None:
            return
        d = dict(attrs)
        href = d.get("href", "")
        if href:
            self.current = {"url": href, "class": d.get("class", ""), "parts": []}

    def handle_data(self, data):
        if self.current is not None:
            self.current["parts"].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            title = " ".join("".join(self.current["parts"]).split())
            self.anchors.append(
                {
                    "url": html.unescape(self.current["url"]),
                    "title": title,
                    "class": self.current["class"],
                }
            )
            self.current = None


def _decode_bing_redirect(url: str):
    p = urlparse(url)
    if not (p.hostname and p.hostname.endswith("bing.com") and p.path.startswith("/ck/")):
        return url
    raw = parse_qs(p.query).get("u", [""])[0]
    if not raw.startswith("a1"):
        return url
    token = raw[2:]
    try:
        token += "=" * (-len(token) % 4)
        decoded = base64.urlsafe_b64decode(token.encode()).decode("utf-8")
        if urlparse(decoded).scheme in {"http", "https"}:
            return decoded
    except Exception:
        pass
    return url


def _external_results(page: str, provider: str, limit: int):
    parser = AnchorParser()
    parser.feed(page)
    reject_hosts = {
        "search.brave.com",
        "cdn.search.brave.com",
        "imgs.search.brave.com",
        "tiles.search.brave.com",
        "www.bing.com",
        "bing.com",
        "r.bing.com",
        "go.microsoft.com",
        "support.microsoft.com",
        "account.microsoft.com",
    }
    seen = set()
    out = []
    for a in parser.anchors:
        if provider == "bing" and "tilk" in a["class"].split():
            continue
        u = _decode_bing_redirect(a["url"]) if provider == "bing" else a["url"]
        p = urlparse(u)
        if p.scheme not in {"http", "https"} or not p.hostname:
            continue
        host = p.hostname.lower()
        if host in reject_hosts or host.endswith(".bing.com") or host.endswith(".brave.com"):
            continue
        title = a["title"].strip()
        if not title or len(title) > 400:
            continue
        # Brave's primary result anchors include l1. For Bing, generic external
        # links are deduplicated and still rank in document order.
        if provider == "brave" and "l1" not in a["class"].split():
            # Keep title-class links too; these include sitelinks and are useful
            # only after primary result anchors.
            if "title" not in a["class"].split():
                continue
        key = u.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "url": u})
        if len(out) >= limit:
            break
    return out


def _search_url(provider: str, query: str):
    q = quote_plus(query)
    if provider == "brave":
        return f"https://search.brave.com/search?q={q}&source=web"
    if provider == "bing":
        return f"https://www.bing.com/search?q={q}"
    raise ValueError(f"unsupported search provider: {provider}")


def search(query: str, rid: str, limit: int = 8, providers=None):
    query = " ".join(str(query).split())
    if not query:
        raise ValueError("query is required")
    limit = max(1, min(int(limit), 20))
    providers = providers or ["brave", "bing"]
    log_event(rid, {"type": "search.start", "query": query, "providers": providers})
    tried = []
    for provider in providers:
        if provider not in {"brave", "bing"}:
            continue
        url = _search_url(provider, query)
        raw = exec_curl(url, retries=1)
        verification = verify_text(raw["body"])
        results = _external_results(raw["body"], provider, limit) if raw["ok"] else []
        # Search HTML often contains dormant captcha/rate-limit strings in scripts.
        # Real normalized result anchors are stronger evidence than those static strings.
        ok = raw["ok"] and bool(results)
        attempt = {
            "provider": provider,
            "ok": ok,
            "http_ok": raw["ok"],
            "results": len(results),
            "elapsed_ms": raw["elapsed_ms"],
            "attempts": raw["attempts"],
            "warnings": verification["warnings"],
            "stderr": raw["stderr"][-500:],
        }
        tried.append(attempt)
        log_event(rid, {"type": "search.provider", **attempt})
        if ok:
            log_event(
                rid,
                {"type": "search.end", "ok": True, "provider": provider, "results": len(results)},
            )
            return {
                "run_id": rid,
                "ok": True,
                "query": query,
                "provider": provider,
                "results": results,
                "tried": tried,
            }
    log_event(rid, {"type": "search.end", "ok": False, "providers": providers})
    return {
        "run_id": rid,
        "ok": False,
        "query": query,
        "provider": None,
        "results": [],
        "tried": tried,
    }


def fetch(url: str, rid: str):
    validate_url(url)
    log_event(rid, {"type": "fetch.start", "url": url})
    out = exec_ab(["read", url], retries=2)
    verification = verify_text(out["stdout"])
    log_event(
        rid,
        {
            "type": "fetch.end",
            "url": url,
            "ok": out["ok"],
            "verified": verification["verified"],
            "elapsed_ms": out["elapsed_ms"],
            "attempts": out["attempts"],
        },
    )
    return {
        "run_id": rid,
        "url": url,
        "content": out["stdout"],
        "verified": verification["verified"],
        "warnings": verification["warnings"],
        **{k: v for k, v in out.items() if k != "stdout"},
    }


def browser_open(url: str, session: str, rid: str, profile: str | None = None):
    validate_url(url)
    if not valid_session(session):
        raise ValueError("invalid session name")
    args = ["--session", session]
    if profile:
        p = profile_path(profile)
        acquire_profile(profile, session)
        args += ["--profile", str(p)]
    log_event(rid, {"type": "browser.open.start", "session": session, "url": url, "profile": profile})
    op = exec_ab([*args, "open", url], retries=1)
    if not op["ok"] and profile:
        release_profile_for_session(session)
    snap = (
        exec_ab(["--session", session, "snapshot", "-c"], retries=1)
        if op["ok"]
        else None
    )
    cdp = exec_ab(["--session", session, "get", "cdp-url"], retries=1) if op["ok"] else None
    snap_verify = verify_text(snap["stdout"]) if snap else {"verified": False, "warnings": ["open-failed"]}
    log_event(
        rid,
        {
            "type": "browser.open.end",
            "session": session,
            "url": url,
            "profile": profile,
            "ok": op["ok"],
            "verified": snap_verify["verified"],
            "elapsed_ms": op["elapsed_ms"],
            "attempts": op["attempts"],
        },
    )
    return {
        "run_id": rid,
        "session": session,
        "profile": profile,
        "cdp_url": cdp["stdout"].strip() if cdp and cdp["ok"] else None,
        "open": op,
        "snapshot": snap,
        "verified": snap_verify["verified"],
        "warnings": snap_verify["warnings"],
    }


def browser_session_info(session: str, rid: str):
    if not valid_session(session):
        raise ValueError("invalid session name")
    title = exec_ab(["--session", session, "get", "title"], retries=1)
    url = exec_ab(["--session", session, "get", "url"], retries=1)
    cdp = exec_ab(["--session", session, "get", "cdp-url"], retries=1)
    ok = title["ok"] and url["ok"] and cdp["ok"]
    profile = next((n for n, owner in PROFILE_LEASES.items() if owner == session), None)
    log_event(rid, {"type":"browser.session.info", "session":session, "ok":ok, "profile":profile})
    return {
        "run_id": rid,
        "ok": ok,
        "session": session,
        "profile": profile,
        "title": title["stdout"].strip() if title["ok"] else None,
        "url": url["stdout"].strip() if url["ok"] else None,
        "cdp_url": cdp["stdout"].strip() if cdp["ok"] else None,
        "checks": {"title":title, "url":url, "cdp":cdp},
    }


def browser_action(session: str, body: dict, rid: str):
    if not valid_session(session):
        raise ValueError("invalid session name")
    action = body.get("action")
    allowed = {
        "click",
        "fill",
        "type",
        "press",
        "back",
        "forward",
        "reload",
        "scroll",
        "snapshot",
        "get",
        "wait",
        "screenshot",
        "eval",
    }
    if action not in allowed:
        raise ValueError(f"unsupported action: {action}")
    args = ["--session", session]
    if action in {"back", "forward", "reload", "snapshot"}:
        args += [action]
        if action == "snapshot" and body.get("compact", True):
            args.append("-c")
    elif action == "press":
        args += ["press", str(body["key"])]
    elif action == "scroll":
        args += [
            "scroll",
            str(body.get("direction", "down")),
            str(int(body.get("pixels", 500))),
        ]
    elif action == "get":
        what = str(body.get("what", "url"))
        args += ["get", what]
        if body.get("selector") is not None:
            args.append(str(body["selector"]))
    elif action == "wait":
        args += ["wait", str(body.get("target", 500))]
    elif action == "screenshot":
        p = RUNS / rid / "screenshot.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        args += ["screenshot", str(p)]
    elif action == "eval":
        script = body.get("script")
        if not isinstance(script, str) or not script:
            raise ValueError("script is required")
        args += ["eval", script]
    else:
        sel = body.get("selector")
        if not isinstance(sel, str) or not sel:
            raise ValueError("selector is required")
        args += [action, sel]
        if action in {"fill", "type"}:
            args.append(str(body.get("text", "")))
    log_event(rid, {"type": "browser.action.start", "session": session, "action": action})
    # Never automatically replay mutating actions: duplicate clicks/form submits are worse than a visible failure.
    retries = 1 if action in {"snapshot", "get"} else 0
    out = exec_ab(args, retries=retries)
    log_event(
        rid,
        {
            "type": "browser.action.end",
            "session": session,
            "action": action,
            "ok": out["ok"],
            "elapsed_ms": out["elapsed_ms"],
            "attempts": out["attempts"],
        },
    )
    return {"run_id": rid, "session": session, "action": action, **out}


def browser_close(session: str, rid: str):
    if not valid_session(session):
        raise ValueError("invalid session name")
    out = exec_ab(["--session", session, "close"])
    release_profile_for_session(session)
    log_event(rid, {"type": "browser.close", "session": session, "ok": out["ok"]})
    return {"run_id": rid, "session": session, **out}


def agent_run(url: str, goal: str, session: str, rid: str, model: str | None = None):
    validate_url(url)
    if not goal.strip():
        raise ValueError("goal is required")
    if not valid_session(session):
        raise ValueError("invalid session name")
    op = exec_ab(["--session", session, "open", url], retries=1)
    if not op["ok"]:
        return {"run_id": rid, "session": session, "open": op, "ok": False}
    args = ["--session", session, "chat", goal, "--quiet"]
    if model:
        args += ["--model", model]
    log_event(
        rid,
        {
            "type": "agent.start",
            "session": session,
            "url": url,
            "goal_sha256": hashlib.sha256(goal.encode()).hexdigest(),
        },
    )
    out = exec_ab(args, timeout=max(DEFAULT_TIMEOUT, 90))
    snap = exec_ab(["--session", session, "snapshot", "-c"], retries=1)
    log_event(
        rid,
        {
            "type": "agent.end",
            "session": session,
            "ok": out["ok"],
            "elapsed_ms": out["elapsed_ms"],
        },
    )
    return {"run_id": rid, "session": session, "result": out, "snapshot": snap, "open": op}


class H(BaseHTTPRequestHandler):
    server_version = "CATFISH/0.3"

    def _json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("content-length", "0") or 0)
        if n > MAX_BODY:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, fmt, *args):
        print("[catfish]", fmt % args)

    def do_GET(self):
        if self.path == "/health":
            return self._json(
                200,
                {
                    "ok": True,
                    "name": "CATFISH",
                    "version": "0.3.0",
                    "backend": "agent-browser",
                    "search": ["brave", "bing"],
                    "allow_private": ALLOW_PRIVATE,
                },
            )
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        rid = run_id()
        try:
            b = self._body()
            if self.path == "/v1/search":
                return self._json(200, search(str(b["query"]), rid, b.get("limit", 8)))
            if self.path == "/v1/fetch":
                return self._json(200, fetch(str(b["url"]), rid))
            if self.path == "/v1/browser/open":
                s = str(b.get("session") or session_id())
                profile = str(b["profile"]) if b.get("profile") is not None else None
                return self._json(200, browser_open(str(b["url"]), s, rid, profile))
            if self.path == "/v1/browser/session":
                return self._json(200, browser_session_info(str(b["session"]), rid))
            if self.path == "/v1/browser/action":
                return self._json(200, browser_action(str(b["session"]), b, rid))
            if self.path == "/v1/browser/close":
                return self._json(200, browser_close(str(b["session"]), rid))
            if self.path == "/v1/agent":
                s = str(b.get("session") or session_id())
                return self._json(
                    200, agent_run(str(b["url"]), str(b["goal"]), s, rid, b.get("model"))
                )
            return self._json(404, {"error": "not found", "run_id": rid})
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e), "run_id": rid})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}", "run_id": rid})


def main():
    ap = argparse.ArgumentParser(description="CATFISH: self-hosted web worker control plane")
    ap.add_argument("--host", default=os.environ.get("CATFISH_HOST", "127.0.0.1"))
    ap.add_argument(
        "--port", type=int, default=int(os.environ.get("CATFISH_PORT", "28765"))
    )
    a = ap.parse_args()
    RUNS.mkdir(exist_ok=True)
    PROFILES.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer((a.host, a.port), H)
    print(f"CATFISH 0.3 listening on http://{a.host}:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
