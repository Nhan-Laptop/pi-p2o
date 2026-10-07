"""Storefront API application factory (revision under review)."""
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .admin import router as admin_router
from .legacy import register_legacy_routes

app = FastAPI(title="Storefront API", version="2.4.2")
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


# Unknown paths answer 404; there is no SPA catch-all that would mask route existence.
@app.exception_handler(404)
async def not_found(_request: Request, _exc) -> JSONResponse:
    return JSONResponse({"detail": "Not Found"}, status_code=404)
