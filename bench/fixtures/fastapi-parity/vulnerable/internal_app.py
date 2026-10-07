"""Mounted internal reporting application."""
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def internal_export(_request):
    """Operations export; the parent application's dependencies are not inherited."""
    return JSONResponse({"export": "internal", "rows": []})


internal_app = Starlette(routes=[Route("/admin/export", internal_export, methods=["GET"])])
