"""
FastAPI Backend — SIH26171 Phase 1

Endpoints:
- POST /agent: Accepts SanitizedContext + user_message, returns Action or Text
- GET /health: Status health check
"""

import os
import logging
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from ai_provider import get_agent_response

# Load environment variables (.env)
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sih26171.server")

app = FastAPI(
    title="SIH26171 Privacy Assistant Backend",
    description="Privacy-boundary backend receiving only SanitizedContext",
    version="1.0.0"
)

# CORS configuration for browser extensions
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic Request & Response Schemas ──

class PageMetadata(BaseModel):
    url: Optional[str] = ""
    title: Optional[str] = ""


class ElementData(BaseModel):
    id: Optional[str] = ""
    tag: str
    role: Optional[str] = None
    text: Optional[str] = None
    label: Optional[str] = None


class SanitizedContextPayload(BaseModel):
    page: Optional[PageMetadata] = None
    elements: Optional[List[ElementData]] = []
    text: Optional[str] = ""
    screenshot: Optional[str] = None


class AgentRequest(BaseModel):
    sanitized_context: SanitizedContextPayload
    user_message: Optional[str] = ""


class ActionPayload(BaseModel):
    action: str
    target: str
    value: Optional[str] = None
    riskLevel: Optional[str] = "low"


class AgentResponse(BaseModel):
    type: str  # "action" or "text"
    action: Optional[ActionPayload] = None
    message: Optional[str] = None
    isMock: Optional[bool] = False
    mockReason: Optional[str] = None


# ── Routes ──

@app.get("/")
def read_root():
    return {
        "service": "SIH26171 Privacy Assistant Backend",
        "version": "1.0.0",
        "status": "online",
        "model": os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
    }


@app.get("/health")
def health_check():
    has_groq_key = bool(os.getenv("GROQ_API_KEY"))
    return {
        "status": "healthy",
        "has_groq_key": has_groq_key,
        "model": os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
    }


@app.post("/agent", response_model=AgentResponse)
async def handle_agent_request(req: AgentRequest):
    """
    Primary agent inference endpoint.
    Only SanitizedContext passes through this boundary.
    """
    try:
        raw_dict = req.sanitized_context.model_dump()
        response_data = await get_agent_response(raw_dict, req.user_message or "")
        return response_data
    except Exception as e:
        logger.error(f"Error handling /agent request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    logger.info(f"Starting SIH26171 Backend on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port)
