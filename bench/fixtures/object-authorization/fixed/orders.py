"""Order service handlers. Decisions come from policy.py; effects run only after an allow."""
from policy import ORDERS, can_export_orders, can_read_order, can_update_field


class Denied(PermissionError):
    """The effective policy denied the request before the protected effect."""


def get_order(principal_id, order_id):
    if not can_read_order(principal_id, order_id):
        raise Denied(f"{principal_id} may not read {order_id}")
    return ORDERS[order_id]


def export_orders(principal_id, tenant):
    if not can_export_orders(principal_id, tenant):
        raise Denied(f"{principal_id} may not export {tenant}")
    return [order for order in ORDERS.values() if order["tenant"] == tenant]


def update_order_field(principal_id, order_id, field, value):
    if not can_update_field(principal_id, order_id, field):
        raise Denied(f"{principal_id} may not update {field} on {order_id}")
    ORDERS[order_id][field] = value
    return ORDERS[order_id]
