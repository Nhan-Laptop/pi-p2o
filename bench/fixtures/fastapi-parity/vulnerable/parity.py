"""Executable mirror of the effective enforcement decisions in app.py.

FastAPI and Starlette are not installed in this offline image. Every branch below mirrors a
route, mount or dependency in app.py so the decisions can be exercised with the standard
library; this is a review aid, not a substitute for the installed framework version.
"""

ALLOW = "allow"
DENY = "deny"

VERIFIED_TOKENS = {
    "token-verified": {"subject": "u-1", "roles": ["member"]},
    "token-verified-admin": {"subject": "ops", "roles": ["admin"]},
}


def _verified_principal(headers):
    authorization = headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        return None
    return VERIFIED_TOKENS.get(authorization.removeprefix("Bearer "))


def _parsed_principal(headers):
    """Mirror of security.parse_bearer: reads the value but never denies."""
    authorization = headers.get("authorization", "")
    if not authorization:
        return {"scheme": "anonymous"}
    return {"scheme": "bearer", "token": authorization.removeprefix("Bearer ")}


def check(path, headers):
    """Return ALLOW or DENY for the effective check attached to ``path``."""
    if path.startswith("/api/v1/reports"):
        return ALLOW if _verified_principal(headers) else DENY
    if path.startswith("/api/v1/admin/"):
        # Router dependency is Depends(parse_bearer); it does not reject anyone.
        _parsed_principal(headers)
        return ALLOW
    if path.startswith("/api/v2/export"):
        # Route dependency is Depends(parse_bearer); it does not reject anyone.
        _parsed_principal(headers)
        return ALLOW
    if path.startswith("/internal/"):
        # The mounted Starlette app does not inherit the parent's dependencies.
        return ALLOW
    return DENY
