"""Routes registered imperatively during the v1 to v2 migration."""
from fastapi import Depends

from .security import parse_api_key


def register_legacy_routes(app) -> None:
    """Attach the legacy report route without touching the v2 routers."""
    app.add_api_route(
        "/v1/report/{report_id}",
        report_handler,
        methods=["GET"],
        dependencies=[Depends(parse_api_key)],
    )


async def report_handler(report_id: str) -> dict:
    """Render one quarterly report for an integrator."""
    return {"report": report_id, "rows": []}
