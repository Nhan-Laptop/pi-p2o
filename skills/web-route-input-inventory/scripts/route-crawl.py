#!/usr/bin/env python3
"""Crawl one same-origin web surface and emit a route and parameter inventory as ONE JSON document.

The crawl is bounded and evidence-shaped: it starts from --url, follows same-origin links and form actions to at most
--depth (0..2), fetches at most --max-requests pages (200 hard cap), and prints one document on stdout:

  {"schema":"p2o-route-inventory/1",
   "routes":[{"path":"/x","methods":["GET"],"params":[{"in":"query|form|path|json","name":"q"}],
              "auth":{"cookie":true|false,"bearer":false}}],
   "crawl":{"seed":"http://host/","depth":2,"principal":"alice","requests":12,"truncated":false}}

Route identity is the path; the method list and the parameter matrix are attributes of it. `auth.cookie` means the
request carried the jar's cookie or the response set one; `auth.bearer` means a 401/403 response named a Bearer
challenge. Parameter values are never read into the output and cookie VALUES never leave this process: only names.

An authenticated crawl reads a Netscape cookie jar that already lives inside your scratch (--cookie-jar); the path is
the only credential-shaped argument and the principal is a label, not a value. Links that look state-changing
(logout, signout, delete, remove, destroy) are inventoried by the page that names them but not fetched.

Usage:
  route_crawl.py --url 'http://127.0.0.1:8080/' --depth 2 --max-requests 200
  route_crawl.py --url 'https://app.example/' --cookie-jar /work/alice.jar --principal alice > /work/inventory.json
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from html.parser import HTMLParser

SCHEMA = "p2o-route-inventory/1"
MAX_REQUESTS = 200
MAX_DEPTH = 2
MAX_ROUTES = 200
MAX_PARAMS = 50
MAX_BODY = 1_000_000
DEFAULT_PORTS = {"http": 80, "https": 443}
VALUE_SHAPED = re.compile(r"^(?:\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", re.I)
DESTRUCTIVE = re.compile(r"(?:log-?out|sign-?out|delete|remove|destroy|unsubscribe)", re.I)
SAFE_NAME = re.compile(r"[^A-Za-z0-9_.\[\]-]+")


class Inventory(HTMLParser):
    """Collect same-page links and form parameter names; it never follows anything by itself."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links = []
        self.forms = []
        self._form = None

    def handle_starttag(self, tag, attrs):
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag == "a":
            href = values.get("href", "").strip()
            if href:
                self.links.append(href)
        elif tag == "form":
            self._form = {"action": values.get("action", "").strip(),
                          "method": (values.get("method") or "get").strip().lower(), "params": []}
        elif tag in ("input", "select", "textarea") and self._form is not None:
            name = parameter_name(values.get("name", ""))
            if name:
                self._form["params"].append(name)

    def handle_endtag(self, tag):
        if tag == "form" and self._form is not None:
            self.forms.append(self._form)
            self._form = None


def parameter_name(value) -> str:
    """A name is inventory; a value is not. Keep only name-shaped characters, bounded."""
    if not isinstance(value, str):
        return ""
    return SAFE_NAME.sub("", value.strip())[:64]


def load_jar(path: str):
    """Read a Netscape cookie jar from scratch; return cookies in memory and never place a value in the output."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        sys.exit("refused: --cookie-jar must be a readable Netscape cookie file inside your scratch")
    cookies, names = [], set()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) < 7:
            continue
        domain, _flag, cookie_path, _secure, _expiry, name, value = fields[:7]
        domain = domain.lstrip(".").lower()
        if not domain or not name:
            continue
        cookies.append({"domain": domain, "path": cookie_path or "/", "name": name, "value": value})
        names.add(name)
    return cookies, sorted(names)


def origin_of(url: str):
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.hostname:
        return None
    return (scheme, parts.hostname.lower(), parts.port or DEFAULT_PORTS[scheme])


def same_origin(left: str, origin) -> bool:
    return origin_of(left) == origin


def normalize(url: str, base: str):
    """Absolute same-origin fetchable URL without fragment or userinfo; None when it is not one."""
    try:
        joined = urllib.parse.urljoin(base, (url or "").strip())
        parts = urllib.parse.urlsplit(joined)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.username or parts.password:
        return None
    path = parts.path or "/"
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def fetch_key(url: str):
    """Dedupe a crawl target by origin, path and the SET of query parameter names (values vary, names identify)."""
    parts = urllib.parse.urlsplit(url)
    names = sorted({pair.split("=", 1)[0] for pair in parts.query.split("&") if pair})
    return (origin_of(url), parts.path or "/", "&".join(names))


def query_names(url: str):
    parts = urllib.parse.urlsplit(url)
    return [pair.split("=", 1)[0] for pair in parts.query.split("&") if pair and pair.split("=", 1)[0]]


def is_html(result) -> bool:
    content_type = (result["headers"].get("Content-Type", "") if result["headers"] else "").lower()
    if "html" in content_type:
        return True
    return b"<" in result["body"][:512] and b">" in result["body"][:512]


def request(url: str, cookies, timeout: float):
    """One bounded GET with the jar's matching cookies; the response is evidence, the request is not echoed."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    path = parts.path or "/"
    supplied = [cookie for cookie in cookies
                if (host == cookie["domain"] or host.endswith("." + cookie["domain"])) and path.startswith(cookie["path"])]
    headers = {"User-Agent": "p2o-route-crawl/1"}
    if supplied:
        headers["Cookie"] = "; ".join(cookie["name"] + "=" + cookie["value"] for cookie in supplied)
    outgoing = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(outgoing, timeout=timeout) as response:
            return {"status": response.status, "headers": response.headers, "body": response.read(MAX_BODY), "sent_cookies": bool(supplied)}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "headers": error.headers, "body": error.read(MAX_BODY), "sent_cookies": bool(supplied)}
    except urllib.error.URLError:
        return {"status": 0, "headers": None, "body": b"", "sent_cookies": bool(supplied)}


def auth_flags(result, sent_cookies: bool):
    """Identity requirements this response shows: a cookie the request carried or the response set, a Bearer challenge."""
    headers = result["headers"]
    set_cookie = bool(headers.get_all("Set-Cookie")) if headers is not None else False
    challenge = ""
    if headers is not None and result["status"] in (401, 403):
        challenge = (headers.get("WWW-Authenticate", "") or "").lower()
    return {"cookie": bool(sent_cookies or set_cookie), "bearer": "bearer" in challenge}


def record(rows, path: str, methods, params, auth) -> None:
    row = rows.setdefault(path, {"methods": set(), "params": set(), "auth": {"cookie": False, "bearer": False}})
    row["methods"].update(method.upper() for method in methods if method)
    row["params"].update(params)
    row["auth"]["cookie"] = row["auth"]["cookie"] or bool(auth.get("cookie"))
    row["auth"]["bearer"] = row["auth"]["bearer"] or bool(auth.get("bearer"))


def safe_seed(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    port = parts.port or DEFAULT_PORTS[parts.scheme.lower()]
    label = f"{parts.scheme.lower()}://{(parts.hostname or '').lower()}"
    if port not in (80, 443) or parts.port is not None:
        label = f"{label}:{port}"
    return (label + (parts.path or "/"))[:300]


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl one same-origin surface and print a route/parameter inventory as one JSON document.")
    parser.add_argument("--url", required=True, help="absolute http(s) seed URL you were authorized to crawl")
    parser.add_argument("--depth", type=int, default=MAX_DEPTH, help=f"same-origin link depth, 0..{MAX_DEPTH}; default {MAX_DEPTH}")
    parser.add_argument("--max-requests", type=int, default=MAX_REQUESTS, help=f"page-fetch cap, 1..{MAX_REQUESTS}; default {MAX_REQUESTS}")
    parser.add_argument("--cookie-jar", help="Netscape cookie jar inside your scratch; only cookie names reach the output")
    parser.add_argument("--principal", help="label for the identity the jar represents; defaults to the jar name")
    parser.add_argument("--timeout", type=float, default=10.0, help="per-request timeout in seconds; default 10")
    args = parser.parse_args()

    seed = normalize(args.url, args.url)
    if seed is None or origin_of(seed) is None:
        sys.exit("refused: --url must be an absolute http(s) URL you were authorized to crawl")
    if not 0 <= args.depth <= MAX_DEPTH:
        sys.exit(f"refused: --depth must be 0..{MAX_DEPTH}")
    if not 1 <= args.max_requests <= MAX_REQUESTS:
        sys.exit(f"refused: --max-requests must be 1..{MAX_REQUESTS}")
    cookies, cookie_names = load_jar(args.cookie_jar) if args.cookie_jar else ([], [])
    principal = SAFE_NAME.sub("-", (args.principal or "").strip())[:60]
    if not principal and args.cookie_jar:
        principal = SAFE_NAME.sub("-", args.cookie_jar.rsplit("/", 1)[-1].rsplit(".", 1)[0])[:60]
    principal = principal or "anonymous"

    origin = origin_of(seed)
    rows, seen, frontier = {}, set(), deque([(seed, 0)])
    requests_made, truncated = 0, False
    while frontier and requests_made < args.max_requests:
        url, depth = frontier.popleft()
        key = fetch_key(url)
        if key in seen:
            continue
        seen.add(key)
        result = request(url, cookies, args.timeout)
        requests_made += 1
        path = urllib.parse.urlsplit(url).path or "/"
        path_params = [("path", "id") for segment in path.split("/") if segment and VALUE_SHAPED.match(segment)]
        query = [("query", name) for name in query_names(url)[:MAX_PARAMS]]
        auth = auth_flags(result, result["sent_cookies"])
        record(rows, path, ["GET"], path_params + query, auth)
        if result["status"] and is_html(result):
            page = Inventory()
            try:
                page.feed(result["body"].decode("utf-8", "replace"))
                page.close()
            except Exception:
                page = Inventory()
            for href in page.links:
                target = normalize(href, url)
                if target and same_origin(target, origin) and depth < args.depth and not DESTRUCTIVE.search(target):
                    frontier.append((target, depth + 1))
            for form in page.forms:
                action = normalize(form["action"] or url, url)
                if not action or not same_origin(action, origin):
                    continue
                method = form["method"] if form["method"] in ("get", "post", "put", "patch", "delete") else "get"
                form_params = [("form", name) for name in form["params"][:MAX_PARAMS]]
                action_query = [("query", name) for name in query_names(action)[:MAX_PARAMS]]
                record(rows, urllib.parse.urlsplit(action).path or "/", [method], form_params + action_query, auth)
                if depth < args.depth and not DESTRUCTIVE.search(action):
                    frontier.append((action, depth + 1))
        if len(rows) >= MAX_ROUTES:
            truncated = True
            break
    if frontier:
        truncated = True

    routes = []
    for path in sorted(rows)[:MAX_ROUTES]:
        row = rows[path]
        routes.append({"path": path, "methods": sorted(row["methods"]),
                       "params": [{"in": location, "name": name} for location, name in sorted(row["params"])[:MAX_PARAMS]],
                       "auth": row["auth"]})
    document = {"schema": SCHEMA, "routes": routes,
                "crawl": {"seed": safe_seed(seed), "depth": args.depth, "principal": principal,
                          "requests": requests_made, "truncated": truncated}}
    print(json.dumps(document, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
