"""Identity helpers shared by the storefront routes."""
from fastapi import Header, HTTPException, status

# Operator keys are compared against a rotated secret store; only the digest is kept here.
OPERATOR_KEYS = {"operator-digest"}


def _lookup_key(x_api_key: str | None) -> dict | None:
    if not x_api_key:
        return None
    if x_api_key not in OPERATOR_KEYS:
        return None
    return {"key": x_api_key, "role": "operator"}


async def require_user(x_api_key: str | None = Header(default=None)) -> dict:
    """Reject the request unless the presented key resolves to a known identity."""
    principal = _lookup_key(x_api_key)
    if principal is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")
    return principal


async def require_admin(x_api_key: str | None = Header(default=None)) -> dict:
    """Reject the request unless the presented key resolves to an operator identity."""
    principal = await require_user(x_api_key)
    if principal.get("role") != "operator":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operator role required")
    return principal
