from typing import Any, Optional, Literal
import time

from fastapi import FastAPI
from pydantic import BaseModel, Field

from vlm import analyze_screenshot


app = FastAPI(
    title="SIH Privacy Browser Agent",
    version="0.5.0"
)


# ============================================================
# REQUEST
# ============================================================

class AnalyzeRequest(BaseModel):

    task: str = (
        "Analyze the page and choose the safest useful action."
    )

    screenshot: str

    detections: list[
        dict[str, Any]
    ] = Field(
        default_factory=list
    )

    page_url: Optional[str] = None

    dom_elements: list[
        dict[str, Any]
    ] = Field(
        default_factory=list
    )

    viewport: Optional[
        dict[str, Any]
    ] = None


# ============================================================
# ACTION
# ============================================================

class Target(BaseModel):

    x: Optional[float] = None

    y: Optional[float] = None

    text: Optional[str] = None


class Action(BaseModel):

    type: Literal[
        "click",
        "scroll",
        "wait",
        "none"
    ]

    target: Optional[Target] = None

    value: Optional[str] = None

    confidence: float = 0.0

    reason: str = ""


# ============================================================
# RESPONSE
# ============================================================

class AnalyzeResponse(BaseModel):

    success: bool

    action: Action

    processing_time_ms: float

    vlm_latency_ms: float

    error: Optional[str] = None


# ============================================================
# ROOT
# ============================================================

@app.get("/")
def root():

    return {

        "status": "ok",

        "service":
            "SIH Privacy Browser Agent",

        "version":
            "0.5.0",

        "privacy":
            "sanitized-input-only",

        "vlm":
            "qwen2.5vl:3b",

        "ollama":
            "local"
    }


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health():

    return {

        "status":
            "healthy",

        "vlm":
            "qwen2.5vl:3b",

        "ollama":
            "local"
    }


# ============================================================
# ANALYZE
# ============================================================

@app.post(
    "/analyze",
    response_model=AnalyzeResponse
)
def analyze(
    request: AnalyzeRequest
):

    start_time =time.perf_counter()

    print()
    print(
        "=========================================="
    )
    print(
        "[ANALYZE REQUEST]"
    )
    print(
        "=========================================="
    )

    print(
        "sanitized screenshot : YES"
    )

    print(
        "detections           :",
        len(request.detections)
    )

    print(
        "safe DOM elements    :",
        len(request.dom_elements)
    )

    print(
        "task                 :",
        request.task
    )

    print(
        "page                 :",
        request.page_url
    )

    print(
        "=========================================="
    )

    # ========================================================
    # VALIDATE SCREENSHOT
    # ========================================================

    if not request.screenshot:

        return AnalyzeResponse(

            success=False,

            action=Action(

                type="none",

                confidence=0.0,

                reason=
                    "No sanitized screenshot received."
            ),

            processing_time_ms=0.0,

            vlm_latency_ms=0.0,

            error=
                "No sanitized screenshot received."
        )

    # ========================================================
    # REAL VLM
    # ========================================================

    try:

        action_data, vlm_latency = (
            analyze_screenshot(

                screenshot_data_url=
                    request.screenshot,

                dom_elements=
                    request.dom_elements,

                page_url=
                    request.page_url,

                task=
                    request.task
            )
        )

        # ====================================================
        # TARGET
        # ====================================================

        target_data =action_data.get(
                "target",
                {}
            )

        action =Action(

                type=
                    action_data[
                        "type"
                    ],

                target=
                    Target(

                        x=
                            target_data.get(
                                "x"
                            ),

                        y=
                            target_data.get(
                                "y"
                            ),

                        text=
                            target_data.get(
                                "text"
                            )
                    ),

                value=
                    action_data.get(
                        "value"
                    ),

                confidence=
                    action_data.get(
                        "confidence",
                        0.0
                    ),

                reason=
                    action_data.get(
                        "reason",
                        ""
                    )
            )

        # ====================================================
        # LATENCY
        # ====================================================

        total_latency = (
            time.perf_counter()
            - start_time
        ) * 1000

        # ====================================================
        # LOG
        # ====================================================

        print()
        print(
            "=========================================="
        )

        print(
            "[VLM SUCCESS]"
        )

        print(
            f"action       : {action.type}"
        )

        print(
            f"confidence   : "
            f"{action.confidence:.2f}"
        )

        print(
            f"VLM latency  : "
            f"{vlm_latency:.2f} ms"
        )

        print(
            f"total latency: "
            f"{total_latency:.2f} ms"
        )

        print(
            f"reason       : "
            f"{action.reason}"
        )

        print(
            "=========================================="
        )

        return AnalyzeResponse(

            success=True,

            action=action,

            processing_time_ms=
                round(
                    total_latency,
                    2
                ),

            vlm_latency_ms=
                round(
                    vlm_latency,
                    2
                ),

            error=None
        )

    # ========================================================
    # VLM ERROR
    # ========================================================

    except Exception as exc:

        total_latency = (
            time.perf_counter()
            - start_time
        ) * 1000

        error_message = str(exc)

        print()
        print(
            "=========================================="
        )

        print(
            "[VLM ERROR]"
        )

        print(
            error_message
        )

        print(
            "=========================================="
        )

        return AnalyzeResponse(

            success=False,

            action=Action(

                type="none",

                confidence=0.0,

                reason=
                    f"VLM error: "
                    f"{error_message}"
            ),

            processing_time_ms=
                round(
                    total_latency,
                    2
                ),

            vlm_latency_ms=
                round(
                    total_latency,
                    2
                ),

            error=
                error_message
        )