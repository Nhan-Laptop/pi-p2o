#!/usr/bin/env python3
"""Push one explicit destination at a time through a parameter that the target fetches.

The target does the fetching; this script only fills the placeholder and records what came back for each destination
you name. It sends one request per destination, in the order given, with no concurrency and no destination discovery.

Usage:
  ssrf_probe.py --target 'http://127.0.0.1:8080/fetch?url={{url}}' \
                --baseline http://127.0.0.1:8080/health \
                --candidate http://169.254.169.254/latest/meta-data/ \
                --candidate http://127.0.0.1:6379/
"""
import argparse
import hashlib
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

PLACEHOLDER = "{{url}}"


def probe(url: str, timeout: float) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        sys.exit("refused: --target must be an absolute http(s) URL you were authorized to test")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as response:
            body, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        body, status = error.read(), error.code
    except urllib.error.URLError as error:
        return f"no-response reason={error.reason}"
    elapsed = (time.monotonic() - started) * 1000
    return f"status={status} bytes={len(body)} sha256_16={hashlib.sha256(body).hexdigest()[:16]} elapsed_ms={elapsed:.0f}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Send one explicit destination at a time through a fetch parameter.")
    parser.add_argument("--target", required=True, help=f"authorized URL containing {PLACEHOLDER} where the destination goes")
    parser.add_argument("--baseline", required=True, help="a destination that is certainly reachable, for comparison")
    parser.add_argument("--candidate", action="append", required=True, help="repeatable; one destination per request")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    if args.target.count(PLACEHOLDER) != 1:
        sys.exit(f"refused: --target must contain {PLACEHOLDER} exactly once")

    for label, destination in [("baseline", args.baseline)] + [("candidate", c) for c in args.candidate]:
        url = args.target.replace(PLACEHOLDER, quote(destination, safe=""))
        print(f"{label}: destination={destination}")
        print(f"{label}: request={url}")
        print(f"{label}: {probe(url, args.timeout)}")


if __name__ == "__main__":
    main()
