#!/usr/bin/env python3
"""Controlled enforcement-parity probe.

Run from this directory:  python3 probe.py

The matrix pairs four controlled principals with every effective route and compares the
decision of the mirrored enforcement (parity.py) against the intended identity requirement.
An observed allow where the intended decision is deny is printed as FAIL.
"""
import sys

import parity

ACTORS = {
    "anonymous": {},
    "forged-token": {"authorization": "Bearer token-forged"},
    "verified-user": {"authorization": "Bearer token-verified"},
    "verified-admin": {"authorization": "Bearer token-verified-admin"},
}

# path -> actor -> intended decision
MATRIX = [
    ("/api/v1/reports", {"anonymous": "deny", "forged-token": "deny", "verified-user": "allow", "verified-admin": "allow"}),
    ("/api/v1/admin/export", {"anonymous": "deny", "forged-token": "deny", "verified-user": "deny", "verified-admin": "allow"}),
    ("/api/v2/export", {"anonymous": "deny", "forged-token": "deny", "verified-user": "allow", "verified-admin": "allow"}),
    ("/internal/admin/export", {"anonymous": "deny", "forged-token": "deny", "verified-user": "deny", "verified-admin": "allow"}),
]


def main():
    failed = 0
    total = 0
    for path, expectations in MATRIX:
        for actor, expected in expectations.items():
            total += 1
            observed = parity.check(path, ACTORS[actor])
            ok = observed == expected
            if not ok:
                failed += 1
            print(f"PARITY {path} actor={actor} expected={expected} observed={observed} {'PASS' if ok else 'FAIL'}")
    print(f"RESULT {total - failed}/{total} route/actor cells match the intended identity requirement")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
