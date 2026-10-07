"""Administrative reporting routes mounted under /api/v1/admin."""
from fastapi import APIRouter, Depends

from security import require_admin

router = APIRouter(tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/export")
async def admin_export() -> dict:
    """Full export used by the operations console."""
    return {"export": "all", "rows": []}
