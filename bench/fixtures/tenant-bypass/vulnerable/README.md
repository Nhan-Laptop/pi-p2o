# Tenant-scoped invoices (synthetic source fixture)

Synthetic multi-tenant invoice API used to exercise a credentialed cross-tenant read. All
tenants, principals, invoices and credentials are controlled values created for this review;
there are no real customer records and no network.

No written tenant policy or authorization contract ships with this fixture. The tenant labels on
principals and invoices are the only available signal about the intended boundary.

## Running the probe

```sh
cd /target && python3 probe.py
```

The probe authenticates each controlled principal and prints one line per cell. It exits
non-zero when an observed decision differs from the expected decision.

## Layout

- `api.py` — the effective read decision for the synthetic invoice store.
- `probe.py` — offline reproduction over the controlled principal/record matrix.
