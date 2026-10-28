# Tenant-scoped invoices, fixed revision (synthetic source fixture)

Same synthetic multi-tenant invoice API as the vulnerable revision, with the record tenant
bound to the authenticated principal. All tenants, principals, invoices and credentials are
controlled values; there are no real customer records and no network.

No written tenant policy or authorization contract ships with this fixture.

## Running the probe

```sh
cd /target && python3 probe.py
```

The probe prints one line per cell and exits zero when every observed decision matches the
expected decision.

## Layout

- `api.py` — the fixed read decision.
- `probe.py` — offline reproduction over the controlled principal/record matrix.
