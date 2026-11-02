#!/usr/bin/env python3
"""Send one marker payload and its control through the same parameter, repeated, and report the difference.

Gate M of the injection ladder needs a payload that changes something and a control that changes nothing, sent
through the same field in the same way. Gate O needs that comparison to hold more than once: one sample is not an
oracle. This script sends an interleaved baseline/payload pair `--runs` times (5 by default), prints each response's
signature and the timing range, and ends with a machine-readable verdict:

  oracle: separated    the response class repeats a difference, or the timing ranges stay disjoint by --min-delta-ms
  oracle: inconclusive a single sample, or a difference the timing ranges cannot separate

The comparison is recorded rather than remembered. URLs, query values and header values are not printed: quote the
receipt, not the request.

Usage:
  marker_probe.py --target 'http://127.0.0.1:8080/q?id={{payload}}' --payload "' AND 1=1--" --baseline "' AND 1=2--"
  marker_probe.py ... --runs 5 --min-delta-ms 150
"""
import argparse
import hashlib
import statistics
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

PLACEHOLDER = "{{payload}}"
MAX_RUNS = 20


def signature(url: str, timeout: float) -> tuple[str, str, float]:
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
        return ("no-response", str(error.reason), 0.0)
    elapsed = (time.monotonic() - started) * 1000
    return (str(status), hashlib.sha256(body).hexdigest()[:16], elapsed)


def median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def judge(baseline: list[tuple[str, str, float]], payload: list[tuple[str, str, float]], runs: int, min_delta_ms: float) -> tuple[str, str]:
    """The repeated-oracle rule: a verdict only when the difference repeats or the timing ranges do not overlap."""
    categorical = sum(1 for pair in zip(baseline, payload) if (pair[0][0], pair[0][1]) != (pair[1][0], pair[1][1]))
    if categorical >= max(1, (runs + 1) // 2):
        return ("separated", f"status or body hash differs in {categorical}/{runs} paired run(s)")
    if runs < 2:
        return ("inconclusive", "a single pair is not a repeated oracle; one timing sample is not proof")
    base = [sample[2] for sample in baseline if sample[0] != "no-response"]
    pay = [sample[2] for sample in payload if sample[0] != "no-response"]
    if not base or not pay:
        return ("inconclusive", "a paired run produced no response, so the timing ranges cannot be compared")
    if min(pay) > max(base) + min_delta_ms:
        return ("separated", f"payload slower: min payload {min(pay):.0f} ms vs max baseline {max(base):.0f} ms (+{min_delta_ms:.0f} ms margin)")
    if min(base) > max(pay) + min_delta_ms:
        return ("separated", f"payload faster: min baseline {min(base):.0f} ms vs max payload {max(pay):.0f} ms (+{min_delta_ms:.0f} ms margin)")
    return ("inconclusive", "timing ranges overlap or the requested margin was not reached")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare one marker payload against one baseline through the same parameter, repeated.")
    parser.add_argument("--target", required=True, help=f"absolute URL containing {PLACEHOLDER} exactly where the value goes")
    parser.add_argument("--payload", required=True, help="marker payload")
    parser.add_argument("--baseline", required=True, help="control value; send the same field without the marker")
    parser.add_argument("--runs", type=int, default=5, help=f"paired baseline/payload repetitions, 1..{MAX_RUNS}; default 5")
    parser.add_argument("--min-delta-ms", type=float, default=150.0, help="timing margin a separated oracle must keep; default 150 ms")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    if args.target.count(PLACEHOLDER) != 1:
        sys.exit(f"refused: --target must contain {PLACEHOLDER} exactly once, so the position is explicit")
    if not 1 <= args.runs <= MAX_RUNS:
        sys.exit(f"refused: --runs must be 1..{MAX_RUNS}")
    if args.min_delta_ms <= 0:
        sys.exit("refused: --min-delta-ms must be positive")

    samples: dict[str, list[tuple[str, str, float]]] = {"baseline": [], "payload": []}
    for run in range(1, args.runs + 1):
        for label, value in (("baseline", args.baseline), ("payload", args.payload)):
            url = args.target.replace(PLACEHOLDER, quote(value, safe=""))
            result = signature(url, args.timeout)
            samples[label].append(result)
            prefix = f"run{run} " if args.runs > 1 else ""
            print(f"{prefix}{label}: status={result[0]} body_sha256_16={result[1]} elapsed_ms={result[2]:.0f}")

    baseline, payload = samples["baseline"], samples["payload"]
    base_times = [sample[2] for sample in baseline if sample[0] != "no-response"]
    pay_times = [sample[2] for sample in payload if sample[0] != "no-response"]
    base_median, pay_median = median(base_times), median(pay_times)
    verdict, reason = judge(baseline, payload, args.runs, args.min_delta_ms)
    if args.runs == 1:
        differs = baseline[0] != payload[0]
    else:
        differs = verdict == "separated" or abs(pay_median - base_median) >= 1.0
    print(f"differs: {'yes' if differs else 'no'} (status, body hash or timing)")
    print(f"control_runs: {args.runs}")
    print(f"timing_ms: baseline_median={base_median:.1f} payload_median={pay_median:.1f} "
          f"baseline_max={(max(base_times) if base_times else 0.0):.1f} payload_min={(min(pay_times) if pay_times else 0.0):.1f}")
    print(f"oracle_reason: {reason}")
    print(f"oracle: {verdict}")


if __name__ == "__main__":
    main()
