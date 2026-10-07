# Orders API (synthetic source fixture)

Synthetic order service used to exercise object-level authorization review. All principals and
objects are controlled test fixtures created for this review; there are no real customer records.

## Running the probe

```sh
cd /target && python3 probe.py
```

The probe calls the exported handler functions with controlled actors and objects. It prints one
line per cell and exits non-zero when an observed decision differs from the expected decision.

## Layout

- `policy.py` — the effective authorization decisions.
- `orders.py` — handler layer; the protected effect runs only after an allow.
- `probe.py` — offline reproduction over the controlled matrix.
