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
# PRIVACY AUDIT CONFIGURATION
# =========================================================

FORBIDDEN_KEYS = {
    "value",
    "inputvalue",
    "input_value",
    "password",
    "otp",
    "secret",
    "credential",
    "credentials",
    "innervalue",
    "rawvalue",
    "fieldvalue",
}


SAFE_DETECTION_KEYS = {
    "id",
    "type",
    "source",
    "tagname",
    "rect",
}


SAFE_DOM_KEYS = {
    "tagname",
    "type",
    "name",
    "id",
    "placeholder",
    "autocomplete",
    "arialabel",
    "role",
    "text",
    "label",
    "rect",
    "left",
    "top",
    "right",
    "bottom",
    "width",
    "height",
}


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
# PRIVACY AUDIT HELPERS
# =========================================================

def find_forbidden_keys(
    obj: Any,
    path: str = "payload"
) -> List[str]:
    """
    Recursively inspect an object for sensitive field names.

    IMPORTANT:
    This function returns only the KEY/PATH.
    It never prints or returns the sensitive VALUE.
    """

    violations = []

    if isinstance(obj, dict):

        for key, value in obj.items():

            normalized_key = str(key).strip().lower()

            if normalized_key in FORBIDDEN_KEYS:

                violations.append(
                    f"{path}.{key}"
                )

                # Do not recurse into the sensitive value.
                continue

            violations.extend(
                find_forbidden_keys(
                    value,
                    f"{path}.{key}"
                )
            )

    elif isinstance(obj, list):

        for index, item in enumerate(obj):

            violations.extend(
                find_forbidden_keys(
                    item,
                    f"{path}[{index}]"
                )
            )

    return violations


def audit_detection_metadata(
    detections: Any
) -> Dict[str, Any]:

    if not isinstance(detections, list):

        return {
            "passed": False,
            "count": 0,
            "violations": [
                "detections is not a list"
            ]
        }

    violations = []

    for index, detection in enumerate(detections):

        if not isinstance(detection, dict):

            violations.append(
                f"detections[{index}] is not an object"
            )

            continue

        # Only reject explicitly sensitive fields.
        # Other harmless metadata is allowed.
        for key in detection.keys():

            normalized_key = (
                str(key)
                .strip()
                .lower()
            )

            if normalized_key in FORBIDDEN_KEYS:

                violations.append(
                    f"detections[{index}].{key}"
                )

    return {
        "passed": len(violations) == 0,
        "count": len(detections),
        "violations": violations
    }

def audit_dom_metadata(
    dom_elements: Any
) -> Dict[str, Any]:

    if not isinstance(dom_elements, list):

        return {
            "passed": False,
            "count": 0,
            "violations": [
                "dom_elements is not a list"
            ]
        }

    violations = []

    for index, element in enumerate(dom_elements):

        if not isinstance(element, dict):

            violations.append(
                f"dom_elements[{index}] is not an object"
            )

            continue

        # Only reject explicitly sensitive fields.
        # Harmless DOM metadata is allowed.
        for key in element.keys():

            normalized_key = (
                str(key)
                .strip()
                .lower()
            )

            if normalized_key in FORBIDDEN_KEYS:

                violations.append(
                    f"dom_elements[{index}].{key}"
                )

    return {
        "passed": len(violations) == 0,
        "count": len(dom_elements),
        "violations": violations
    }


def audit_page_url(
    page_url: Any
) -> Dict[str, Any]:

    if not isinstance(page_url, str):

        return {
            "passed": False,
            "reason": "page_url is not a string"
        }

    # -----------------------------------------------------
    # Query parameters and fragments may contain sensitive
    # information, so they are not allowed.
    # -----------------------------------------------------

    has_query = "?" in page_url
    has_fragment = "#" in page_url

    return {
        "passed": not has_query and not has_fragment,
        "query_present": has_query,
        "fragment_present": has_fragment
    }


def audit_screenshot(
    screenshot_data_url: Any
) -> Dict[str, Any]:

    if not isinstance(
        screenshot_data_url,
        str
    ):

        return {
            "passed": False,
            "present": False,
            "format": ""
        }

    if not screenshot_data_url:

        return {
            "passed": False,
            "present": False,
            "format": ""
        }

    # -----------------------------------------------------
    # We allow only image representations produced by the
    # local screenshot sanitization pipeline.
    # -----------------------------------------------------

    if screenshot_data_url.startswith(
        "data:image/webp;base64,"
    ):

        image_format = "image/webp"

    elif screenshot_data_url.startswith(
        "data:image/png;base64,"
    ):

        image_format = "image/png"

    elif screenshot_data_url.startswith(
        "data:image/jpeg;base64,"
    ):

        image_format = "image/jpeg"

    else:

        return {
            "passed": False,
            "present": True,
            "format": "unknown"
        }

    return {
        "passed": True,
        "present": True,
        "format": image_format
    }


def run_privacy_audit(
    *,
    screenshot_data_url: Any,
    detections: Any,
    dom_elements: Any,
    page_url: Any,
    viewport: Any
) -> Dict[str, Any]:

    screenshot_audit = audit_screenshot(
        screenshot_data_url
    )

    detection_audit = audit_detection_metadata(
        detections
    )

    dom_audit = audit_dom_metadata(
        dom_elements
    )

    url_audit = audit_page_url(
        page_url
    )

    # -----------------------------------------------------
    # Recursive final defense-in-depth scan.
    # -----------------------------------------------------

    metadata_payload = {
        "detections": detections,
        "dom_elements": dom_elements,
        "viewport": viewport
    }

    forbidden_paths = find_forbidden_keys(
        metadata_payload
    )

    passed = (
        screenshot_audit["passed"]
        and detection_audit["passed"]
        and dom_audit["passed"]
        and url_audit["passed"]
        and len(forbidden_paths) == 0
    )

    return {
        "passed": passed,

        "sanitized_screenshot": (
            screenshot_audit["passed"]
        ),

        "screenshot_format": (
            screenshot_audit["format"]
        ),

        "detection_values_present": (
            not detection_audit["passed"]
        ),

        "raw_dom_values_present": (
            not dom_audit["passed"]
        ),

        "sensitive_url_present": (
            not url_audit["passed"]
        ),

        "forbidden_metadata_paths": (
            forbidden_paths
        ),

        "detection_count": (
            detection_audit["count"]
        ),

        "dom_element_count": (
            dom_audit["count"]
        )
    }


# =========================================================
# SAFE PRIVACY AUDIT LOG
# =========================================================

def print_privacy_audit(
    audit: Dict[str, Any]
) -> None:

    print()
    print("==========================================")
    print("[PRIVACY AUDIT]")
    print("==========================================")

    print(
        "Sanitized screenshot : "
        f"{'YES' if audit['sanitized_screenshot'] else 'NO'}"
    )

    print(
        "Screenshot format    : "
        f"{audit['screenshot_format'] or 'NONE'}"
    )

    print(
        "Detection values     : "
        f"{'PRESENT' if audit['detection_values_present'] else 'NOT PRESENT'}"
    )

    print(
        "Raw DOM values       : "
        f"{'PRESENT' if audit['raw_dom_values_present'] else 'NOT PRESENT'}"
    )

    print(
        "Sensitive URL data   : "
        f"{'PRESENT' if audit['sensitive_url_present'] else 'NOT PRESENT'}"
    )

    print(
        "Detection regions    : "
        f"{audit['detection_count']}"
    )

    print(
        "Safe DOM elements    : "
        f"{audit['dom_element_count']}"
    )

    print(
        "Forbidden metadata   : "
        f"{len(audit['forbidden_metadata_paths'])}"
    )

    print(
        "Privacy gate         : "
        f"{'PASS' if audit['passed'] else 'BLOCKED'}"
    )

    print("==========================================")


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

    # -----------------------------------------------------
    # PRIVACY AUDIT
    # -----------------------------------------------------

    privacy_audit = run_privacy_audit(

        screenshot_data_url=screenshot_data_url,

        detections=detections,

        dom_elements=dom_elements,

        page_url=page_url,

        viewport=viewport
    )

    print_privacy_audit(
        privacy_audit
    )

    # -----------------------------------------------------
    # Privacy gate
    # -----------------------------------------------------

    if not privacy_audit["passed"]:

        total_time = (
            time.perf_counter()
            - start_time
        ) * 1000

        print(
            "[PRIVACY] Request BLOCKED before VLM."
        )

        return AnalyzeResponse(

            success=False,

            processing_time_ms=round(
                total_time,
                2
            ),

            error=(
                "Privacy audit failed. "
                "Sensitive or unsafe metadata was "
                "detected before VLM processing."
            )
        )

    # -----------------------------------------------------
    # Safe request summary
    #
    # IMPORTANT:
    # Do NOT print screenshot base64.
    # Do NOT print detection values.
    # Do NOT print DOM values.
    # Do NOT print the task here because the explicit
    # user task may intentionally contain a value to type.
    # -----------------------------------------------------

    print(
        f"[SAFE REQUEST] "
        f"detections={len(detections)} "
        f"dom_elements={len(dom_elements)} "
        f"screenshot={privacy_audit['screenshot_format']}"
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