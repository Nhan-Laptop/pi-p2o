"""Routes registered imperatively during the v1 to v2 migration."""
from fastapi import Depends, HTTPException, status

from .security import require_user

# Reports are owned by the integrating partner; ownership is checked after lookup.
REPORT_OWNERS = {"q3-2026": "operator-digest"}


def register_legacy_routes(app) -> None:
    """Attach the legacy report route without touching the v2 routers."""
    app.add_api_route(
        "/v1/report/{report_id}",
        report_handler,
        methods=["GET"],
        dependencies=[Depends(require_user)],
    )


async def report_handler(report_id: str, principal: dict = Depends(require_user)) -> dict:
    """Render one quarterly report for its owning integrator."""
    if REPORT_OWNERS.get(report_id) != principal["key"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown report")
    return {"report": report_id, "rows": []}
