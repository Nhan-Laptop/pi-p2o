#!/usr/bin/env python3
"""Send one marker payload and one baseline through the same parameter, then report the difference.

Gate M of the injection ladder needs a payload that changes something and a control that changes nothing, sent
through the same field in the same way. This script does exactly that pair and prints both responses' signatures, so
the comparison is recorded rather than remembered.

Usage:
  marker_probe.py --target 'http://127.0.0.1:8080/q?id={{payload}}' --payload "' AND 1=1--" --baseline "' AND 1=2--"
"""
import argparse
import hashlib
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

PLACEHOLDER = "{{payload}}"


def signature(url: str, timeout: float) -> tuple[str, str, str]:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        sys.exit("refused: --target must be an absolute http(s) URL you were authorized to test")
    request = urllib.request.Request(url, method="GET")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        body, status = error.read(), error.code
    except urllib.error.URLError as error:
        return ("no-response", str(error.reason), "0")
    elapsed = (time.monotonic() - started) * 1000
    return (str(status), hashlib.sha256(body).hexdigest()[:16], f"{elapsed:.0f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare one marker payload against one baseline through the same parameter.")
    parser.add_argument("--target", required=True, help=f"absolute URL containing {PLACEHOLDER} exactly where the value goes")
    parser.add_argument("--payload", required=True, help="marker payload")
    parser.add_argument("--baseline", required=True, help="control value; send the same field without the marker")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    if args.target.count(PLACEHOLDER) != 1:
        sys.exit(f"refused: --target must contain {PLACEHOLDER} exactly once, so the position is explicit")

    results = {}
    for label, value in (("payload", args.payload), ("baseline", args.baseline)):
        url = args.target.replace(PLACEHOLDER, quote(value, safe=""))
        results[label] = signature(url, args.timeout)
        print(f"{label}: url={url}")
        print(f"{label}: status={results[label][0]} body_sha256_16={results[label][1]} elapsed_ms={results[label][2]}")

    differs = results["payload"] != results["baseline"]
    print(f"differs: {'yes' if differs else 'no'} (status, body hash or timing)")
    print("note: a timing-only difference needs at least five control runs before it means anything")


if __name__ == "__main__":
    main()
