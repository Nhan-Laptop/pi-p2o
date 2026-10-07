"""Admin routes mounted at /admin by the application factory."""
from fastapi import APIRouter, Depends

from .security import require_admin

router = APIRouter(tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/export")
async def export_orders() -> dict:
    """Full order export used by the finance console."""
    return {"export": "orders", "rows": []}


@router.get("/audit")
async def audit_log() -> dict:
    """Append-only audit tail."""
    return {"export": "audit", "rows": []}
