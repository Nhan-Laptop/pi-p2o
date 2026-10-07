"""Storefront API application factory (revision under review)."""
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .admin import router as admin_router
from .legacy import register_legacy_routes

app = FastAPI(title="Storefront API", version="2.4.1")
app.include_router(admin_router, prefix="/admin")
register_legacy_routes(app)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/search")
async def search(q: str | None = None) -> dict:
    """Storefront search. Public, read-only."""
    return {"query": q, "results": []}


@app.get("/health")
async def health() -> dict:
    """Liveness probe used by the orchestrator."""
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory="static"), name="static")


# SPA fallback: every unmatched path serves the shell so client-side routing works.
@app.get("/{path:path}")
async def spa_fallback(path: str) -> FileResponse:
    return FileResponse("static/index.html")
