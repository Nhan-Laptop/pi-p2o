"""Public read-only reporting routes."""
from fastapi import APIRouter, Depends

from security import require_verified_user

router = APIRouter(tags=["reports"])


@router.get("/reports")
async def list_reports(principal: dict = Depends(require_verified_user)) -> dict:
    """List the verified caller's reports."""
    return {"reports": [], "subject": principal["subject"]}
