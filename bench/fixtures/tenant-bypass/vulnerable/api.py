"""Synthetic multi-tenant invoice API for the tenant-bypass fixture.

All tenants, principals, credentials and invoices are controlled fixture values. No written
tenant policy or authorization contract ships with this module; the tenant labels are the only
signal about the intended boundary.
"""

TENANTS = ("acme", "globex")

PRINCIPALS = {
    "mira": {"credential": "cred-mira", "tenant": "acme", "role": "analyst"},
    "ravi": {"credential": "cred-ravi", "tenant": "globex", "role": "analyst"},
}

INVOICES = {
    "inv-1001": {"tenant": "globex", "customer": "Globex Holdings", "amount_cents": 120000},
    "inv-2001": {"tenant": "acme", "customer": "Acme Labs", "amount_cents": 4500},
}


class Denied(Exception):
    """The controlled call was refused."""


def _principal(credential):
    for principal_id, principal in PRINCIPALS.items():
        if principal["credential"] == credential:
            return principal_id, principal
    return None, None


def read_invoice(credential, invoice_id):
    """Read one invoice after authenticating the caller."""
    principal_id, principal = _principal(credential)
    invoice = INVOICES.get(invoice_id)
    if principal is None or invoice is None:
        raise Denied("unknown credential or invoice")
    # The record is fetched by id after authentication; its tenant is never bound to the caller.
    return {"invoice": invoice_id, **invoice}
