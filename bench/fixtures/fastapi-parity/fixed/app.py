"""Reporting API application factory (revision under review)."""
from fastapi import Depends, FastAPI

from internal_app import internal_app
from routers import admin, public
from security import require_verified_user

app = FastAPI(title="Reporting API", version="3.1.3")

# The platform terminates TLS and forwards the client identity headers.
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

app.include_router(public.router, prefix="/api/v1")
# The admin router verifies identity and the admin role at router level.
app.include_router(admin.router, prefix="/api/v1/admin")

# The mounted application carries its own verification wrapper.
app.mount("/internal", internal_app)


@app.get("/api/v2/export")
async def export_v2(principal: dict = Depends(require_verified_user)) -> dict:
    """New export endpoint introduced in v2; clients switch over gradually."""
    return {"export": True, "actor": principal}
