"""Identity dependencies for the reporting API."""
from fastapi import HTTPException, Header, status

# Verified identities are resolved by the platform identity service; the map below mirrors it
# for the offline review.
VERIFIED_TOKENS = {
    "token-verified": {"subject": "u-1", "roles": ["member"]},
    "token-verified-admin": {"subject": "ops", "roles": ["admin"]},
}


async def parse_bearer(authorization: str | None = Header(default=None)) -> dict:
    """Diagnostic helper kept for audit labels; it is never the only identity check.

    Every route that previously used it now depends on require_verified_user (or
    require_admin), so an anonymous value cannot reach a protected effect.
    """
    if not authorization:
        return {"scheme": "anonymous"}
    return {"scheme": "bearer", "token": authorization.removeprefix("Bearer ")}


def verify_token(authorization: str | None) -> dict | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return VERIFIED_TOKENS.get(authorization.removeprefix("Bearer "))


async def require_verified_user(authorization: str | None = Header(default=None)) -> dict:
    principal = verify_token(authorization)
    if principal is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token")
    return principal


async def require_admin(authorization: str | None = Header(default=None)) -> dict:
    principal = await require_verified_user(authorization)
    if "admin" not in principal["roles"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return principal
