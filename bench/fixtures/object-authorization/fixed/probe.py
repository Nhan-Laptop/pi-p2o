#!/usr/bin/env python3
"""Controlled offline probe for the order authorization policy.

Run from this directory:  python3 probe.py

Every cell uses the controlled principals and objects defined in policy.py. The probe prints
one line per cell and exits non-zero when an observed decision differs from the expected one,
so the vulnerable and fixed revisions can be compared without a running service.
"""
import sys

import orders


def decision(call):
    """Run one controlled call and reduce it to allow/deny."""
    try:
        value = call()
    except orders.Denied:
        return "deny"
    if isinstance(value, list):
        return "allow" if value else "deny"
    return "allow" if value else "deny"


CELLS = [
    ("owner-read-own", "alice reads her own order o-1001", "allow",
     lambda: orders.get_order("alice", "o-1001")),
    ("same-tenant-foreign-read", "carol reads alice's order o-1001 in tenant t-a", "deny",
     lambda: orders.get_order("carol", "o-1001")),
    ("other-tenant-read", "bob reads alice's order o-1001 in tenant t-a", "deny",
     lambda: orders.get_order("bob", "o-1001")),
    ("anonymous-read", "an unauthenticated caller reads o-1001", "deny",
     lambda: orders.get_order("anonymous", "o-1001")),
    ("export-own-tenant", "alice exports her own tenant t-a", "allow",
     lambda: orders.export_orders("alice", "t-a")),
    ("export-other-tenant", "alice exports tenant t-b", "deny",
     lambda: orders.export_orders("alice", "t-b")),
    ("update-own-shipping", "alice updates the shipping address on her own order", "allow",
     lambda: orders.update_order_field("alice", "o-1001", "shipping_address", "1 A St")),
    ("update-foreign-shipping", "carol updates the shipping address on alice's order", "deny",
     lambda: orders.update_order_field("carol", "o-1001", "shipping_address", "9 C St")),
    ("update-total-denied", "alice updates the total on her own order", "deny",
     lambda: orders.update_order_field("alice", "o-1001", "total_cents", 1)),
]


def main():
    failed = 0
    for cell_id, description, expected, call in CELLS:
        observed = decision(call)
        ok = observed == expected
        if not ok:
            failed += 1
        print(f"CELL {cell_id} expected={expected} observed={observed} {'PASS' if ok else 'FAIL'} :: {description}")
    print(f"RESULT {len(CELLS) - failed}/{len(CELLS)} cells match the expected policy")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
