from typing import Any, Dict, List, Optional
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from vlm import analyze_screenshot


app = FastAPI(
    title="SIH Privacy Browser Agent",
    version="0.1.0"
)


# =========================================================
# CORS
# =========================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# REQUEST MODEL
# =========================================================

class AnalyzeRequest(BaseModel):

    screenshot_data_url: Optional[str] = None

    detections: List[Dict[str, Any]] = Field(
        default_factory=list
    )

    page_url: str = ""

    dom_elements: List[Dict[str, Any]] = Field(
        default_factory=list
    )

    viewport: Dict[str, Any] = Field(
        default_factory=dict
    )

    task: str = (
        "Analyze the page and choose the safest useful action."
    )


# =========================================================
# RESPONSE MODEL
# =========================================================

class AnalyzeResponse(BaseModel):

    success: bool

    action: Optional[Dict[str, Any]] = None

    processing_time_ms: Optional[float] = None

    vlm_latency_ms: Optional[float] = None

    error: Optional[str] = None


# =========================================================
# HEALTH
# =========================================================

@app.get("/health")
def health():

    return {
        "status": "healthy",
        "vlm": "qwen2.5vl:3b",
        "ollama": "local"
    }


# =========================================================
# ANALYZE
# =========================================================

@app.post(
    "/analyze",
    response_model=AnalyzeResponse
)
async def analyze(
    request: Request
):

    start_time = time.perf_counter()

    # -----------------------------------------------------
    # Read raw JSON
    # -----------------------------------------------------

    try:

        body = await request.json()

    except Exception as exc:

        return AnalyzeResponse(
            success=False,
            error=f"Invalid JSON request: {exc}"
        )

    print()
    print("==========================================")
    print("[ANALYZE REQUEST]")
    print("==========================================")

    print(
        f"Received fields: {list(body.keys())}"
    )

    # -----------------------------------------------------
    # Accept both possible screenshot names
    # -----------------------------------------------------

    screenshot_data_url = (
        body.get("screenshot_data_url")
        or body.get("screenshot")
        or body.get("sanitizedImage")
        or body.get("sanitized_image")
    )

    detections = (
        body.get("detections")
        or []
    )

    page_url = (
        body.get("page_url")
        or body.get("url")
        or ""
    )

    dom_elements = (
        body.get("dom_elements")
        or body.get("domElements")
        or []
    )

    viewport = (
        body.get("viewport")
        or {}
    )

    task = (
        body.get("task")
        or "Analyze the page and choose the safest useful action."
    )

    print(
        f"sanitized screenshot : "
        f"{'YES' if screenshot_data_url else 'NO'}"
    )

    print(
        f"detections           : "
        f"{len(detections)}"
    )

    print(
        f"safe DOM elements    : "
        f"{len(dom_elements)}"
    )

    print(
        f"task                 : "
        f"{task}"
    )

    print(
        f"page                 : "
        f"{page_url}"
    )

    print(
        "=========================================="
    )

    # -----------------------------------------------------
    # Validate screenshot manually
    # -----------------------------------------------------

    if not screenshot_data_url:

        total_time = (
            time.perf_counter()
            - start_time
        ) * 1000

        return AnalyzeResponse(

            success=False,

            processing_time_ms=round(
                total_time,
                2
            ),

            error=(
                "No sanitized screenshot was "
                "received from the extension."
            )
        )

    # -----------------------------------------------------
    # Call VLM
    # -----------------------------------------------------

    try:

        result = analyze_screenshot(

            screenshot_data_url=screenshot_data_url,

            detections=detections,

            page_url=page_url,

            dom_elements=dom_elements,

            task=task
        )

        total_time = (
            time.perf_counter()
            - start_time
        ) * 1000

        print(
            f"[ANALYZE] action="
            f"{result.get('action')}"
        )

        print(
            f"[ANALYZE] VLM latency="
            f"{result.get('vlm_latency_ms', 0):.2f} ms"
        )

        print(
            f"[ANALYZE] Total latency="
            f"{total_time:.2f} ms"
        )

        return AnalyzeResponse(

            success=True,

            action=result,

            processing_time_ms=round(
                total_time,
                2
            ),

            vlm_latency_ms=result.get(
                "vlm_latency_ms"
            )
        )

    except Exception as exc:

        total_time = (
            time.perf_counter()
            - start_time
        ) * 1000

        print()
        print("==========================================")
        print("[ANALYZE ERROR]")
        print("==========================================")

        print(
            f"{type(exc).__name__}: {exc}"
        )

        print(
            "=========================================="
        )

        return AnalyzeResponse(

            success=False,

            processing_time_ms=round(
                total_time,
                2
            ),

            error=str(exc)
        )