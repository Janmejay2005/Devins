import os
import re
import json
import time
import base64
from io import BytesIO
from typing import Any, Dict, List, Optional

import requests
from PIL import Image


# ============================================================
# CONFIGURATION
# ============================================================

# fast  = local DOM-grounded planner for live demo
# qwen  = local Qwen2.5-VL visual reasoning
VLM_MODE = os.getenv("VLM_MODE", "fast").lower().strip()

OLLAMA_URL = os.getenv(
    "OLLAMA_URL",
    "http://127.0.0.1:11434/api/chat"
)

MODEL = os.getenv(
    "OLLAMA_MODEL",
    "qwen2.5vl:3b"
)

OLLAMA_TIMEOUT = int(
    os.getenv("OLLAMA_TIMEOUT", "120")
)

MAX_IMAGE_WIDTH = 448
MAX_IMAGE_HEIGHT = 448
JPEG_QUALITY = 55

NUM_CTX = 1024
NUM_PREDICT = 48


# ============================================================
# QWEN SYSTEM PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are a browser computer-use agent.

You receive:
1. A SANITIZED screenshot.
2. Safe DOM metadata.
3. Local privacy detections.

IMPORTANT PRIVACY RULES:
- The screenshot has already been sanitized locally.
- Sensitive information may appear as black/redacted regions.
- Never attempt to reconstruct hidden sensitive information.
- Never invent passwords, IDs, card numbers, emails, phone numbers,
  or other private values.
- Do not type sensitive information unless the task explicitly provides
  the value and the browser action is clearly requested.

Your job is to select ONE useful browser action.

Allowed actions:

click:
{
  "action": "click",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": ""
}

type:
{
  "action": "type",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": ""
}

scroll:
{
  "action": "scroll",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 500,
  "confidence": 0.0,
  "reason": ""
}

wait:
{
  "action": "wait",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": ""
}

none:
{
  "action": "none",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": ""
}

Return ONLY valid JSON.
"""


# ============================================================
# IMAGE OPTIMIZATION
# ============================================================

def optimize_image(screenshot_data_url: str) -> str:
    """
    Resize the already-sanitized screenshot before sending it
    to the local VLM.
    """

    if not screenshot_data_url:
        raise ValueError("Empty screenshot data.")

    if "," in screenshot_data_url:
        encoded = screenshot_data_url.split(",", 1)[1]
    else:
        encoded = screenshot_data_url

    raw = base64.b64decode(encoded)

    image = Image.open(BytesIO(raw)).convert("RGB")

    original_width, original_height = image.size

    image.thumbnail(
        (MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT),
        Image.Resampling.LANCZOS
    )

    output = BytesIO()

    image.save(
        output,
        format="JPEG",
        quality=JPEG_QUALITY,
        optimize=True
    )

    optimized_base64 = base64.b64encode(
        output.getvalue()
    ).decode("utf-8")

    print(
        f"[VLM] Original image: "
        f"{original_width}x{original_height}"
    )

    print(
        f"[VLM] Optimized image: "
        f"{image.width}x{image.height}"
    )

    print(
        f"[VLM] Optimized image size: "
        f"{len(output.getvalue()) / 1024:.1f} KB"
    )

    return optimized_base64


# ============================================================
# TEXT NORMALIZATION
# ============================================================

def normalize_text(value: Any) -> str:
    if value is None:
        return ""

    return re.sub(
        r"\s+",
        " ",
        str(value)
    ).strip().lower()


def element_text(element: Dict[str, Any]) -> str:
    parts = [
        element.get("text"),
        element.get("innerText"),
        element.get("ariaLabel"),
        element.get("aria_label"),
        element.get("placeholder"),
        element.get("name"),
        element.get("id"),
        element.get("type"),
    ]

    return " ".join(
        str(x)
        for x in parts
        if x
    )


def get_number(
    element: Dict[str, Any],
    *keys: str,
    default: float = 0
) -> float:

    for key in keys:
        value = element.get(key)

        if isinstance(value, (int, float)):
            return float(value)

        try:
            if value is not None:
                return float(value)
        except Exception:
            pass

    return default


# ============================================================
# DOM GEOMETRY
# ============================================================

def get_element_center(
    element: Dict[str, Any]
) -> tuple[float, float]:

    # Direct center coordinates
    cx = get_number(
        element,
        "centerX",
        "center_x",
        "cx",
        default=-1
    )

    cy = get_number(
        element,
        "centerY",
        "center_y",
        "cy",
        default=-1
    )

    if cx >= 0 and cy >= 0:
        return cx, cy

    # Bounding rectangle
    x = get_number(
        element,
        "x",
        "left",
        default=0
    )

    y = get_number(
        element,
        "y",
        "top",
        default=0
    )

    width = get_number(
        element,
        "width",
        default=0
    )

    height = get_number(
        element,
        "height",
        default=0
    )

    return (
        x + width / 2,
        y + height / 2
    )


# ============================================================
# DOM ELEMENT TYPE
# ============================================================

def is_input(element: Dict[str, Any]) -> bool:

    tag = normalize_text(
        element.get("tag")
        or element.get("tagName")
    )

    element_type = normalize_text(
        element.get("type")
    )

    return (
        tag in {
            "input",
            "textarea",
            "select"
        }
        or element_type in {
            "text",
            "email",
            "tel",
            "password",
            "number",
            "search",
            "url"
        }
    )


def is_button(element: Dict[str, Any]) -> bool:

    tag = normalize_text(
        element.get("tag")
        or element.get("tagName")
    )

    element_type = normalize_text(
        element.get("type")
    )

    text = normalize_text(
        element_text(element)
    )

    if tag == "button":
        return True

    if element_type in {
        "button",
        "submit",
        "reset"
    }:
        return True

    button_words = [
        "submit",
        "save",
        "continue",
        "next",
        "login",
        "sign in",
        "search",
        "send",
        "verify"
    ]

    return any(
        word in text
        for word in button_words
    )


# ============================================================
# TASK KEYWORDS
# ============================================================

def task_contains(task: str, words: List[str]) -> bool:

    normalized = normalize_text(task)

    return any(
        word in normalized
        for word in words
    )


def extract_quoted_text(task: str) -> str:

    patterns = [
        r'"([^"]+)"',
        r"'([^']+)'",
        r"`([^`]+)`"
    ]

    for pattern in patterns:
        match = re.search(
            pattern,
            task
        )

        if match:
            return match.group(1)

    return ""


# ============================================================
# ELEMENT MATCHING
# ============================================================

def score_element(
    element: Dict[str, Any],
    task: str
) -> float:

    task_text = normalize_text(task)
    element_text_value = normalize_text(
        element_text(element)
    )

    if not element_text_value:
        return -1000

    score = 0.0

    # --------------------------------------------------------
    # Exact task words
    # --------------------------------------------------------

    task_words = set(
        re.findall(
            r"[a-zA-Z0-9]+",
            task_text
        )
    )

    element_words = set(
        re.findall(
            r"[a-zA-Z0-9]+",
            element_text_value
        )
    )

    common_words = task_words & element_words

    score += len(common_words) * 12

    # --------------------------------------------------------
    # Semantic field matching
    # --------------------------------------------------------

    semantic_groups = {
        "name": [
            "name",
            "full name",
            "first name",
            "last name"
        ],
        "email": [
            "email",
            "e-mail",
            "mail"
        ],
        "phone": [
            "phone",
            "mobile",
            "telephone",
            "contact"
        ],
        "address": [
            "address",
            "location"
        ],
        "password": [
            "password",
            "passcode"
        ],
        "aadhaar": [
            "aadhaar",
            "aadhar"
        ],
        "pan": [
            "pan",
            "permanent account"
        ],
        "card": [
            "card",
            "credit card",
            "debit card"
        ],
        "submit": [
            "submit",
            "save",
            "continue",
            "next",
            "send"
        ]
    }

    for group, keywords in semantic_groups.items():

        if any(
            keyword in task_text
            for keyword in keywords
        ):

            if any(
                keyword in element_text_value
                for keyword in keywords
            ):
                score += 35

    # --------------------------------------------------------
    # Input/button compatibility
    # --------------------------------------------------------

    if task_contains(
        task,
        ["click", "press", "select", "open", "tap"]
    ):

        if is_button(element):
            score += 15

        if is_input(element):
            score += 8

    # --------------------------------------------------------
    # Type compatibility
    # --------------------------------------------------------

    if task_contains(
        task,
        ["type", "enter", "fill", "write"]
    ):

        if is_input(element):
            score += 25

    # --------------------------------------------------------
    # Submit compatibility
    # --------------------------------------------------------

    if task_contains(
        task,
        ["submit", "send", "continue", "next"]
    ):

        if is_button(element):
            score += 40

    return score


# ============================================================
# FAST DOM PLANNER
# ============================================================

def fast_plan(
    task: str,
    dom_elements: List[Dict[str, Any]],
    detections: List[Dict[str, Any]]
) -> Dict[str, Any]:

    start = time.perf_counter()

    if not dom_elements:
        return {
            "action": "none",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": 0,
            "confidence": 0.0,
            "reason": "No safe DOM elements were available."
        }

    # --------------------------------------------------------
    # Scroll request
    # --------------------------------------------------------

    if task_contains(
        task,
        [
            "scroll down",
            "scroll downward",
            "scroll lower"
        ]
    ):

        amount = 600

        match = re.search(
            r"(\d+)\s*(?:px|pixels)?",
            task.lower()
        )

        if match:
            amount = int(
                match.group(1)
            )

        latency = (
            time.perf_counter() - start
        ) * 1000

        print(
            f"[FAST PLANNER] "
            f"scroll amount={amount} "
            f"latency={latency:.2f} ms"
        )

        return {
            "action": "scroll",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": amount,
            "confidence": 0.98,
            "reason": "Task explicitly requested a downward scroll."
        }

    if task_contains(
        task,
        [
            "scroll up",
            "scroll upward"
        ]
    ):

        latency = (
            time.perf_counter() - start
        ) * 1000

        return {
            "action": "scroll",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": -600,
            "confidence": 0.98,
            "reason": "Task explicitly requested an upward scroll."
        }

    # --------------------------------------------------------
    # Score every safe DOM element
    # --------------------------------------------------------

    scored = []

    for index, element in enumerate(
        dom_elements
    ):

        score = score_element(
            element,
            task
        )

        if score > -500:

            scored.append(
                (
                    score,
                    index,
                    element
                )
            )

    scored.sort(
        key=lambda item: item[0],
        reverse=True
    )

    if not scored:

        return {
            "action": "none",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": 0,
            "confidence": 0.0,
            "reason": "No suitable safe DOM element matched the task."
        }

    best_score, best_index, best_element = scored[0]

    x, y = get_element_center(
        best_element
    )

    readable_name = (
        best_element.get("text")
        or best_element.get("ariaLabel")
        or best_element.get("placeholder")
        or best_element.get("name")
        or best_element.get("id")
        or best_element.get("tagName")
        or "target element"
    )

    # --------------------------------------------------------
    # Determine action
    # --------------------------------------------------------

    is_typing = task_contains(
        task,
        [
            "type",
            "enter",
            "fill",
            "write"
        ]
    )

    is_clicking = task_contains(
        task,
        [
            "click",
            "press",
            "tap",
            "select",
            "open"
        ]
    )

    is_submitting = task_contains(
        task,
        [
            "submit",
            "send",
            "continue",
            "next"
        ]
    )

    # --------------------------------------------------------
    # Type action
    # --------------------------------------------------------

    if is_typing and is_input(best_element):

        typed_text = extract_quoted_text(
            task
        )

        if typed_text:

            latency = (
                time.perf_counter() - start
            ) * 1000

            print(
                f"[FAST PLANNER] "
                f"type target={readable_name} "
                f"latency={latency:.2f} ms"
            )

            return {
                "action": "type",
                "x": round(x),
                "y": round(y),
                "text": typed_text,
                "amount": 0,
                "confidence": 0.96,
                "reason": (
                    f"Matched '{readable_name}' "
                    f"from safe DOM metadata."
                )
            }

        # No explicit value -> click input instead.
        latency = (
            time.perf_counter() - start
        ) * 1000

        return {
            "action": "click",
            "x": round(x),
            "y": round(y),
            "text": "",
            "amount": 0,
            "confidence": 0.90,
            "reason": (
                f"Matched '{readable_name}' "
                f"as the requested input field. "
                f"No explicit typing value was provided."
            )
        }

    # --------------------------------------------------------
    # Submit action
    # --------------------------------------------------------

    if is_submitting and is_button(
        best_element
    ):

        latency = (
            time.perf_counter() - start
        ) * 1000

        return {
            "action": "click",
            "x": round(x),
            "y": round(y),
            "text": "",
            "amount": 0,
            "confidence": 0.97,
            "reason": (
                f"Matched '{readable_name}' "
                f"as the requested action button."
            )
        }

    # --------------------------------------------------------
    # Normal click
    # --------------------------------------------------------

    if is_clicking:

        latency = (
            time.perf_counter() - start
        ) * 1000

        print(
            f"[FAST PLANNER] "
            f"click target={readable_name} "
            f"score={best_score:.1f} "
            f"latency={latency:.2f} ms"
        )

        confidence = min(
            0.98,
            max(
                0.55,
                0.55 + best_score / 100
            )
        )

        return {
            "action": "click",
            "x": round(x),
            "y": round(y),
            "text": "",
            "amount": 0,
            "confidence": round(
                confidence,
                2
            ),
            "reason": (
                f"Matched '{readable_name}' "
                f"from safe DOM metadata."
            )
        }

    # --------------------------------------------------------
    # Generic task fallback
    # --------------------------------------------------------

    latency = (
        time.perf_counter() - start
    ) * 1000

    return {
        "action": "click",
        "x": round(x),
        "y": round(y),
        "text": "",
        "amount": 0,
        "confidence": 0.60,
        "reason": (
            f"Selected '{readable_name}' "
            f"as the safest available target."
        )
    }


# ============================================================
# JSON EXTRACTION
# ============================================================

def extract_json(text: str) -> Dict[str, Any]:

    if not text:
        raise ValueError(
            "VLM returned an empty response."
        )

    text = text.strip()

    # Direct JSON
    try:
        return json.loads(text)
    except Exception:
        pass

    # Markdown JSON block
    fenced = re.search(
        r"```(?:json)?\s*(\{.*?\})\s*```",
        text,
        re.DOTALL
    )

    if fenced:
        try:
            return json.loads(
                fenced.group(1)
            )
        except Exception:
            pass

    # First JSON object
    start = text.find("{")
    end = text.rfind("}")

    if start >= 0 and end > start:

        candidate = text[
            start:end + 1
        ]

        try:
            return json.loads(
                candidate
            )
        except Exception:
            pass

    raise ValueError(
        f"Could not parse JSON from VLM response: {text[:500]}"
    )


# ============================================================
# ACTION NORMALIZATION
# ============================================================

def normalize_action(
    action: Dict[str, Any]
) -> Dict[str, Any]:

    allowed = {
        "click",
        "type",
        "scroll",
        "wait",
        "none"
    }

    action_name = str(
        action.get("action", "none")
    ).lower().strip()

    if action_name not in allowed:
        action_name = "none"

    try:
        x = round(
            float(
                action.get("x", 0)
            )
        )
    except Exception:
        x = 0

    try:
        y = round(
            float(
                action.get("y", 0)
            )
        )
    except Exception:
        y = 0

    try:
        amount = round(
            float(
                action.get("amount", 0)
            )
        )
    except Exception:
        amount = 0

    try:
        confidence = float(
            action.get(
                "confidence",
                0
            )
        )
    except Exception:
        confidence = 0

    confidence = max(
        0.0,
        min(
            1.0,
            confidence
        )
    )

    text = action.get(
        "text",
        ""
    )

    if text is None:
        text = ""

    return {
        "action": action_name,
        "x": x,
        "y": y,
        "text": str(text),
        "amount": amount,
        "confidence": round(
            confidence,
            2
        ),
        "reason": str(
            action.get(
                "reason",
                ""
            )
        )
    }


# ============================================================
# QWEN LOCAL VISION
# ============================================================

def qwen_plan(
    screenshot_data_url: str,
    detections: List[Dict[str, Any]],
    page_url: str,
    dom_elements: List[Dict[str, Any]],
    task: str
) -> Dict[str, Any]:

    start_time = time.perf_counter()

    optimized_image = optimize_image(
        screenshot_data_url
    )

    # Keep DOM context compact.
    safe_dom = []

    for element in dom_elements[:20]:

        safe_dom.append({
            "tag": element.get(
                "tag",
                element.get(
                    "tagName",
                    ""
                )
            ),
            "text": element.get(
                "text",
                ""
            ),
            "ariaLabel": element.get(
                "ariaLabel",
                ""
            ),
            "placeholder": element.get(
                "placeholder",
                ""
            ),
            "type": element.get(
                "type",
                ""
            ),
            "x": element.get(
                "x",
                element.get(
                    "left",
                    0
                )
            ),
            "y": element.get(
                "y",
                element.get(
                    "top",
                    0
                )
            ),
            "width": element.get(
                "width",
                0
            ),
            "height": element.get(
                "height",
                0
            )
        })

    safe_detections = []

    for detection in detections[:20]:

        safe_detections.append({
            "type": detection.get(
                "type",
                ""
            ),
            "x": detection.get(
                "x",
                0
            ),
            "y": detection.get(
                "y",
                0
            ),
            "width": detection.get(
                "width",
                0
            ),
            "height": detection.get(
                "height",
                0
            )
        })

    user_prompt = f"""
TASK:
{task}

PAGE:
{page_url}

SAFE DOM ELEMENTS:
{json.dumps(safe_dom, separators=(",", ":"))}

LOCAL PRIVACY DETECTIONS:
{json.dumps(safe_detections, separators=(",", ":"))}

Choose the safest useful browser action.

Remember:
- Sensitive regions are already sanitized.
- Never reconstruct redacted information.
- Return JSON only.
"""

    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": user_prompt,
                "images": [
                    optimized_image
                ]
            }
        ],
        "stream": False,
        "keep_alive": "5m",
        "options": {
            "temperature": 0,
            "num_ctx": NUM_CTX,
            "num_predict": NUM_PREDICT
        }
    }

    print()
    print("==========================================")
    print("[QWEN VISION REQUEST]")
    print("==========================================")
    print(
        f"[VLM] Model: {MODEL}"
    )
    print(
        "[VLM] Sending SANITIZED image to Ollama..."
    )

    try:

        response = requests.post(
            OLLAMA_URL,
            json=payload,
            timeout=OLLAMA_TIMEOUT
        )

    except requests.Timeout:

        elapsed = (
            time.perf_counter()
            - start_time
        ) * 1000

        raise RuntimeError(
            "Ollama vision inference timed out "
            f"after {elapsed / 1000:.1f} seconds."
        )

    except requests.RequestException as exc:

        raise RuntimeError(
            f"Ollama request failed: {exc}"
        )

    if response.status_code != 200:

        raise RuntimeError(
            f"Ollama returned HTTP "
            f"{response.status_code}: "
            f"{response.text[:500]}"
        )

    try:
        response_json = response.json()
    except Exception:

        raise RuntimeError(
            "Ollama returned invalid JSON."
        )

    content = (
        response_json
        .get("message", {})
        .get("content", "")
    )

    print()
    print("==========================================")
    print("[QWEN RAW RESPONSE]")
    print("==========================================")
    print(content)

    parsed = extract_json(
        content
    )

    action = normalize_action(
        parsed
    )

    latency = (
        time.perf_counter()
        - start_time
    ) * 1000

    print(
        f"[QWEN] Action: "
        f"{action['action']}"
    )

    print(
        f"[QWEN] Confidence: "
        f"{action['confidence']:.2f}"
    )

    print(
        f"[QWEN] Total latency: "
        f"{latency:.2f} ms"
    )

    return {
        **action,
        "vlm_latency_ms": round(
            latency,
            2
        ),
        "provider": "ollama",
        "mode": "qwen"
    }


# ============================================================
# MAIN ENTRY POINT
# ============================================================

def analyze_screenshot(
    screenshot_data_url: Optional[str] = None,
    detections: Optional[List[Dict[str, Any]]] = None,
    page_url: str = "",
    dom_elements: Optional[List[Dict[str, Any]]] = None,
    task: str = (
        "Analyze the page and choose "
        "the safest useful action."
    )
) -> Dict[str, Any]:

    start_time = time.perf_counter()

    detections = detections or []
    dom_elements = dom_elements or []

    print()
    print("==========================================")
    print("[ACTION PLANNER]")
    print("==========================================")
    print(
        f"Mode                 : {VLM_MODE}"
    )
    print(
        f"Safe DOM elements    : {len(dom_elements)}"
    )
    print(
        f"Local PII detections : {len(detections)}"
    )
    print(
        f"Task                 : {task}"
    )

    # ========================================================
    # FAST MODE
    # ========================================================

    if VLM_MODE == "fast":

        action = fast_plan(
            task=task,
            dom_elements=dom_elements,
            detections=detections
        )

        total_latency = (
            time.perf_counter()
            - start_time
        ) * 1000

        action["vlm_latency_ms"] = round(
            total_latency,
            2
        )

        action["provider"] = "local"
        action["mode"] = "fast"

        print(
            f"[FAST] Action: "
            f"{action['action']}"
        )

        print(
            f"[FAST] Target: "
            f"({action['x']}, {action['y']})"
        )

        print(
            f"[FAST] Confidence: "
            f"{action['confidence']:.2f}"
        )

        print(
            f"[FAST] Latency: "
            f"{total_latency:.2f} ms"
        )

        print("==========================================")

        return action

    # ========================================================
    # QWEN MODE
    # ========================================================

    if VLM_MODE == "qwen":

        if not screenshot_data_url:

            return {
                "action": "none",
                "x": 0,
                "y": 0,
                "text": "",
                "amount": 0,
                "confidence": 0,
                "reason": (
                    "No sanitized screenshot "
                    "was provided."
                ),
                "vlm_latency_ms": 0,
                "provider": "ollama",
                "mode": "qwen"
            }

        return qwen_plan(
            screenshot_data_url=screenshot_data_url,
            detections=detections,
            page_url=page_url,
            dom_elements=dom_elements,
            task=task
        )

    # ========================================================
    # UNKNOWN MODE
    # ========================================================

    raise ValueError(
        f"Unsupported VLM_MODE='{VLM_MODE}'. "
        "Use 'fast' or 'qwen'."
    )