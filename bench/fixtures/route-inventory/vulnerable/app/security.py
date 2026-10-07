"""Identity helpers shared by the storefront routes."""
from fastapi import Header


async def parse_api_key(x_api_key: str | None = Header(default=None)) -> dict:
    """Read the gateway-injected key so handlers can record the caller label.

    The platform gateway is expected to reject anonymous traffic before it reaches the
    application, so this helper only needs to surface the header value.
    """
    return {"key": x_api_key}
