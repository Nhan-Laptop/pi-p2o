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


def check(path, headers):
    """Return ALLOW or DENY for the effective check attached to ``path``."""
    if path.startswith("/api/v1/reports"):
        return ALLOW if _verified_principal(headers) else DENY
    if path.startswith("/api/v1/admin/"):
        principal = _verified_principal(headers)
        return ALLOW if principal and "admin" in principal["roles"] else DENY
    if path.startswith("/api/v2/export"):
        return ALLOW if _verified_principal(headers) else DENY
    if path.startswith("/internal/"):
        # The mounted app carries RequireVerifiedAdmin middleware.
        principal = _verified_principal(headers)
        return ALLOW if principal and "admin" in principal["roles"] else DENY
    return DENY
