"""Order authorization policy for the synthetic order service."""
PRINCIPALS = {
    "alice": {"authenticated": True, "tenant": "t-a", "roles": ["member"]},
    "bob": {"authenticated": True, "tenant": "t-b", "roles": ["member"]},
    "carol": {"authenticated": True, "tenant": "t-a", "roles": ["member"]},
    "ops": {"authenticated": True, "tenant": "t-a", "roles": ["admin"]},
    "anonymous": {"authenticated": False, "tenant": "t-a", "roles": []},
}

ORDERS = {
    "o-1001": {"owner": "alice", "tenant": "t-a", "total_cents": 1200, "shipping_address": "1 A St"},
    "o-2001": {"owner": "bob", "tenant": "t-b", "total_cents": 3400, "shipping_address": "2 B St"},
}

FIELD_POLICY = {"total_cents": "admin", "shipping_address": "owner"}


def can_read_order(principal_id, order_id):
    principal = PRINCIPALS.get(principal_id)
    order = ORDERS.get(order_id)
    if not principal or not principal["authenticated"] or order is None:
        return False
    if principal["tenant"] != order["tenant"]:
        return False
    return order["owner"] == principal_id or "admin" in principal["roles"]


def can_export_orders(principal_id, tenant):
    principal = PRINCIPALS.get(principal_id)
    if not principal or not principal["authenticated"]:
        return False
    return tenant == principal["tenant"]


def can_update_field(principal_id, order_id, field):
    principal = PRINCIPALS.get(principal_id)
    order = ORDERS.get(order_id)
    if not principal or not principal["authenticated"] or order is None:
        return False
    if principal["tenant"] != order["tenant"]:
        return False
    required = FIELD_POLICY.get(field)
    if required is None:
        return False
    if required == "admin":
        return "admin" in principal["roles"]
    return order["owner"] == principal_id or "admin" in principal["roles"]
