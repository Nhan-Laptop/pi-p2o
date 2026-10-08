"""Inert source-mapping fixture: no server, network or external dependencies."""
ROUTES = {
    ("GET", "/health"): "health",
    ("GET", "/orders/{order_id}"): "read_order",
    ("POST", "/exports"): "enqueue_export",
}


def tenant_guard(principal, order):
    return principal["tenant"] == order["tenant"]


def health():
    return {"status": "ok"}


def read_order(principal, order):
    if not tenant_guard(principal, order):
        return {"status": "denied"}
    return {"status": "ok", "id": order["id"]}


def enqueue_export(principal, queue):
    queue.append({"tenant": principal["tenant"], "requested_by": principal["id"]})


def publish_export(job, service_principal):
    # The consumer runs as a service, not as the initiating request principal.
    return {"tenant": job["tenant"], "executor": service_principal["id"]}
