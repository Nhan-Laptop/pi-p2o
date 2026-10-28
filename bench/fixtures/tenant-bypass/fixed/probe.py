#!/usr/bin/env python3
"""Controlled probe for the synthetic tenant-scoped invoice API.

Run from this directory:  python3 probe.py

Every cell uses a controlled credential and a controlled invoice. The probe prints one line per
cell and exits non-zero when an observed decision differs from the expected decision, so the
vulnerable and fixed revisions can be compared without a running service or network.
"""
import sys

import api


def decision(call):
    """Run one controlled call and reduce it to allow/deny."""
    try:
        value = call()
    except api.Denied:
        return "deny"
    return "allow" if value else "deny"


CELLS = [
    ("cross-tenant-read",
     "mira (tenant acme) reads inv-1001 (tenant globex)",
     "deny",
     lambda: api.read_invoice("cred-mira", "inv-1001")),
    ("same-tenant-read",
     "mira reads inv-2001 in her own tenant acme",
     "allow",
     lambda: api.read_invoice("cred-mira", "inv-2001")),
    ("anonymous-read",
     "an unknown credential reads inv-1001",
     "deny",
     lambda: api.read_invoice("cred-anonymous", "inv-1001")),
]


def main():
    failed = 0
    for cell_id, description, expected, call in CELLS:
        observed = decision(call)
        ok = observed == expected
        if not ok:
            failed += 1
        print(f"CELL {cell_id} expected={expected} observed={observed} {'PASS' if ok else 'FAIL'} :: {description}")
        if cell_id == "cross-tenant-read" and observed == "allow":
            print("REPLAY cross-tenant-read principal=mira principal_tenant=acme "
                  "record=inv-1001 record_tenant=globex effect=read")
    print(f"RESULT {len(CELLS) - failed}/{len(CELLS)} cells match the expected decisions")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
