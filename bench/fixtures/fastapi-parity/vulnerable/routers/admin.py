"""Administrative reporting routes mounted under /api/v1/admin."""
from fastapi import APIRouter

router = APIRouter(tags=["admin"])


@router.get("/export")
async def admin_export() -> dict:
    """Full export used by the operations console."""
    return {"export": "all", "rows": []}
