"""Mounted internal reporting application."""
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from security import verify_token


class RequireVerifiedAdmin:
    """Mounted applications get their own identity check instead of inheriting the parent."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope, receive)
            principal = verify_token(request.headers.get("authorization"))
            if principal is None or "admin" not in principal["roles"]:
                response = JSONResponse({"detail": "Admin identity required"}, status_code=403)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


async def internal_export(_request):
    """Operations export, reachable only with a verified admin identity."""
    return JSONResponse({"export": "internal", "rows": []})


internal_app = Starlette(
    routes=[Route("/admin/export", internal_export, methods=["GET"])],
    middleware=[Middleware(RequireVerifiedAdmin)],
)
