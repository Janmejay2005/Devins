import base64
import io
import json
import os
import re
import time
from typing import Any, Dict, List, Optional

import requests
from PIL import Image


# ============================================================
# CONFIGURATION
# ============================================================

VLM_MODE = os.getenv("VLM_MODE", "fast").lower().strip()

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen2.5vl:3b"

OLLAMA_TIMEOUT = 120
MAX_IMAGE_SIZE = 448
JPEG_QUALITY = 55


# ============================================================
# QWEN SYSTEM PROMPT
# ============================================================

SYSTEM_PROMPT = """
You are a privacy-aware browser computer-use agent.

You receive:
1. A SANITIZED screenshot.
2. Safe DOM metadata.
3. A user browser task.

The screenshot has already been redacted locally.
Never request, reconstruct, infer, or expose sensitive values.

Allowed actions:
- click
- type
- scroll
- wait
- none

Return ONLY JSON:

{
  "action": "click",
  "x": 100,
  "y": 100,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": "short explanation"
}

For type:
- text MUST come only from the explicit user task.
- Never copy a sensitive value from the page.
- Never type into password/credential fields.

If uncertain, return action "none".
"""


# ============================================================
# IMAGE OPTIMIZATION
# ============================================================

def optimize_image(encoded_image: str) -> str:

    try:
        image_bytes = base64.b64decode(encoded_image)
        image = Image.open(io.BytesIO(image_bytes))

        print(
            f"[VLM] Original image: "
            f"{image.width}x{image.height}"
        )

        image.thumbnail(
            (MAX_IMAGE_SIZE, MAX_IMAGE_SIZE),
            Image.Resampling.LANCZOS
        )

        print(
            f"[VLM] Optimized image: "
            f"{image.width}x{image.height}"
        )

        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")

        output = io.BytesIO()

        image.save(
            output,
            format="JPEG",
            quality=JPEG_QUALITY,
            optimize=True
        )

        optimized = output.getvalue()

        print(
            f"[VLM] Optimized image size: "
            f"{len(optimized) / 1024:.1f} KB"
        )

        return base64.b64encode(
            optimized
        ).decode("utf-8")

    except Exception as exc:

        print(
            f"[VLM] Image optimization failed: {exc}"
        )

        return encoded_image


# ============================================================
# TEXT HELPERS
# ============================================================

def normalize_text(value: Any) -> str:

    return re.sub(
        r"\s+",
        " ",
        str(value or "")
    ).strip()


def task_lower(task: str) -> str:

    return normalize_text(task).lower()


def extract_explicit_type_value(task: str) -> Optional[str]:

    """
    Extract ONLY text explicitly quoted by the user.

    Examples:
        Type "Vansh" in the Full Name field
        Enter 'hello' into the city field
        Fill the field with "ABC"

    We intentionally do not infer values from the webpage.
    """

    patterns = [
        r"""["“](.*?)["”]""",
        r"""['‘](.*?)['’]"""
    ]

    for pattern in patterns:

        match = re.search(
            pattern,
            task or "",
            flags=re.DOTALL
        )

        if match:

            value = normalize_text(
                match.group(1)
            )

            if value:
                return value

    return None


def is_type_task(task: str) -> bool:

    t = task_lower(task)

    type_verbs = (
        "type ",
        "enter ",
        "fill ",
        "write ",
        "input ",
        "insert ",
        "put "
    )

    target_words = (
        "field",
        "input",
        "textbox",
        "text box",
        "form"
    )

    has_type_verb = any(
        t.startswith(word) or
        f" {word}" in t
        for word in type_verbs
    )

    has_target = any(
        word in t
        for word in target_words
    )

    has_explicit_value = (
        extract_explicit_type_value(task)
        is not None
    )

    return (
        has_type_verb and
        has_target and
        has_explicit_value
    )


# ============================================================
# SAFE DOM TARGET HELPERS
# ============================================================

def dom_text(element: Dict[str, Any]) -> str:

    return normalize_text(
        " ".join(
            [
                str(element.get("label") or ""),
                str(element.get("text") or ""),
                str(element.get("aria") or ""),
                str(element.get("placeholder") or ""),
                str(element.get("name") or "")
            ]
        )
    )


def target_name(element: Dict[str, Any]) -> str:

    return dom_text(element).lower()


def element_is_sensitive(
    element: Dict[str, Any],
    detections: List[Dict[str, Any]]
) -> bool:

    tag = str(
        element.get("tag") or ""
    ).lower()

    element_type = str(
        element.get("type") or ""
    ).lower()

    element_name = target_name(
        element
    )

    # --------------------------------------------------------
    # HARD BLOCK — PASSWORD / CREDENTIAL / OTP CONTROLS
    # --------------------------------------------------------

    if element_type == "password":
        return True

    if (
        "password" in element_name or
        "credential" in element_name or
        "otp" in element_name
    ):
        return True

    # --------------------------------------------------------
    # BUTTON SAFETY
    # --------------------------------------------------------
    #
    # Buttons do not contain the user's typed form value.
    #
    # Therefore a PII detection elsewhere on the page must
    # NOT automatically make a normal submit button unsafe.
    #
    # This is particularly important for:
    #
    # <input type="submit" value="Submit">
    #
    # or:
    #
    # <button type="submit">Submit</button>
    #
    # --------------------------------------------------------

    is_button_like = (
        tag == "button" or
        tag == "a" or
        element_type in (
            "submit",
            "button",
            "reset"
        ) or
        str(
            element.get("role") or ""
        ).lower()
        in (
            "button",
            "link"
        )
    )

    if is_button_like:

        return False

    # --------------------------------------------------------
    # NORMAL INPUT / TEXTAREA PROTECTION
    # --------------------------------------------------------
    #
    # For editable controls, PII-overlap remains a hard block.
    #
    # This prevents the planner from selecting a sensitive
    # field even if the task asks it to do so.
    # --------------------------------------------------------

    try:

        x = float(
            element.get(
                "x",
                0
            ) or 0
        )

        y = float(
            element.get(
                "y",
                0
            ) or 0
        )

        w = float(
            element.get(
                "width",
                0
            ) or 0
        )

        h = float(
            element.get(
                "height",
                0
            ) or 0
        )

        right = x + w

        bottom = y + h

        for detection in detections:

            rect = (
                detection.get("rect")
                or {}
            )

            dl = float(
                rect.get(
                    "left",
                    detection.get(
                        "x",
                        0
                    )
                ) or 0
            )

            dt = float(
                rect.get(
                    "top",
                    detection.get(
                        "y",
                        0
                    )
                ) or 0
            )

            dr = float(
                rect.get(
                    "right",
                    dl + float(
                        rect.get(
                            "width",
                            detection.get(
                                "width",
                                0
                            )
                        ) or 0
                    )
                )
            )

            db = float(
                rect.get(
                    "bottom",
                    dt + float(
                        rect.get(
                            "height",
                            detection.get(
                                "height",
                                0
                            )
                        ) or 0
                    )
                )
            )

            overlap = (
                x < dr and
                right > dl and
                y < db and
                bottom > dt
            )

            if overlap:

                return True

    except Exception:

        pass

    return False


def element_center(
    element: Dict[str, Any]
) -> tuple[int, int]:

    x = float(element.get("x", 0) or 0)
    y = float(element.get("y", 0) or 0)
    w = float(element.get("width", 0) or 0)
    h = float(element.get("height", 0) or 0)

    return (
        int(round(x + w / 2)),
        int(round(y + h / 2))
    )


# ============================================================
# FIELD MATCHING
# ============================================================

FIELD_ALIASES = {
    "full name": [
        "full name",
        "name",
        "applicant name",
        "citizen name"
    ],
    "email": [
        "email",
        "email address",
        "e-mail"
    ],
    "phone": [
        "phone",
        "mobile",
        "mobile number",
        "phone number",
        "contact number"
    ],
    "submit": [
        "submit",
        "submit application",
        "submit form"
    ]
}


def extract_requested_target(task: str) -> str:

    t = task_lower(task)

    # ========================================================
    # 1. EXPLICIT FIELD TARGETS
    # ========================================================
    #
    # IMPORTANT:
    # If the task contains BOTH:
    #
    #   "Fill the Full Name field with ..."
    #   "and submit the form"
    #
    # the TYPE planner must resolve "full name",
    # not "submit".
    #
    # ========================================================

    patterns = [

        # Fill the Full Name field
        r"\bfill\s+(?:the\s+)?([a-z][a-z0-9 _-]*?)\s+field\b",

        # Enter value in the Full Name field
        r"\b(?:enter|write|input|insert|put)\s+(?:.*?\s+)?in\s+(?:the\s+)?([a-z][a-z0-9 _-]*?)\s+field\b",

        # in the Full Name field
        r"\bin\s+(?:the\s+)?([a-z][a-z0-9 _-]*?)\s+field\b",

        # into the Full Name field
        r"\binto\s+(?:the\s+)?([a-z][a-z0-9 _-]*?)\s+field\b",

        # to the Full Name field
        r"\bto\s+(?:the\s+)?([a-z][a-z0-9 _-]*?)\s+field\b",

        # generic "Full Name field"
        r"\b([a-z][a-z0-9 _-]*)\s+field\b"
    ]


    for pattern in patterns:

        match = re.search(
            pattern,
            t
        )

        if match:

            candidate = normalize_text(
                match.group(1)
            )

            if candidate:

                # --------------------------------------------
                # Normalize known aliases
                # --------------------------------------------

                candidate_lower = candidate.lower()

                for canonical, aliases in FIELD_ALIASES.items():

                    for alias in aliases:

                        if (
                            candidate_lower == alias.lower()
                            or alias.lower() in candidate_lower
                        ):
                            return canonical

                return candidate


    # ========================================================
    # 2. SUBMIT / BUTTON TARGET
    # ========================================================

    submit_patterns = [

        r"\bclick\s+(?:the\s+)?submit\b",

        r"\bpress\s+(?:the\s+)?submit\b",

        r"\bselect\s+(?:the\s+)?submit\b",

        r"\bsubmit\s+(?:the\s+)?form\b",

        r"\bsubmit\s+(?:the\s+)?application\b"
    ]


    for pattern in submit_patterns:

        if re.search(
            pattern,
            t
        ):

            return "submit"


    # ========================================================
    # 3. FIELD ALIASES
    # ========================================================

    for canonical, aliases in FIELD_ALIASES.items():

        for alias in aliases:

            if alias.lower() in t:

                return canonical


    # ========================================================
    # 4. NOTHING FOUND
    # ========================================================

    return ""
def score_element_for_target(
    element: Dict[str, Any],
    target: str
) -> float:

    target_text = (
        str(target or "")
        .lower()
        .strip()
    )

    if not target_text:
        return 0.0

    tag = (
        str(element.get("tag") or "")
        .lower()
        .strip()
    )

    element_type = (
        str(element.get("type") or "")
        .lower()
        .strip()
    )

    role = (
        str(element.get("role") or "")
        .lower()
        .strip()
    )

    name = (
        str(element.get("name") or "")
        .lower()
        .strip()
    )

    element_id = (
        str(element.get("id") or "")
        .lower()
        .strip()
    )

    placeholder = (
        str(element.get("placeholder") or "")
        .lower()
        .strip()
    )

    aria_label = (
        str(element.get("aria-label") or "")
        .lower()
        .strip()
    )

    title = (
        str(element.get("title") or "")
        .lower()
        .strip()
    )

    value = (
        str(element.get("value") or "")
        .lower()
        .strip()
    )

    text = (
        str(
            element.get("text")
            or element.get("text_content")
            or element.get("inner_text")
            or ""
        )
        .lower()
        .strip()
    )

    # ---------------------------------------------------------
    # SPECIAL CASE — SUBMIT
    # ---------------------------------------------------------

    if target_text in (
        "submit",
        "submit button",
        "submit form",
        "submission"
    ):

        score = 0.0

        # Explicit submit input type
        if (
            tag == "input"
            and element_type == "submit"
        ):
            score += 100

        # Button element
        if tag == "button":
            score += 40

        # Button/link role
        if role == "button":
            score += 35

        # Text / value containing submit
        searchable_fields = [
            text,
            value,
            name,
            element_id,
            aria_label,
            title
        ]

        for field in searchable_fields:

            if "submit" in field:
                score += 30

        # Common submit-related names
        if (
            "submit" in name
            or "submit" in element_id
            or "submit" in aria_label
            or "submit" in title
        ):
            score += 20

        if score > 0:

            print(
                "[SUBMIT MATCH]",
                {
                    "tag": tag,
                    "type": element_type,
                    "role": role,
                    "text": text,
                    "value": value,
                    "name": name,
                    "id": element_id,
                    "aria-label": aria_label,
                    "score": score
                }
            )

        return score


    # ---------------------------------------------------------
    # NORMAL TARGET MATCHING
    # ---------------------------------------------------------

    score = 0.0

    target_words = [
        word
        for word in target_text.split()
        if word
    ]

    searchable_fields = [
        ("text", text, 50),
        ("aria-label", aria_label, 45),
        ("placeholder", placeholder, 40),
        ("name", name, 35),
        ("id", element_id, 30),
        ("title", title, 30),
        ("value", value, 25)
    ]

    for field_name, field_value, field_score in searchable_fields:

        if not field_value:
            continue

        # Exact match
        if field_value == target_text:

            score += field_score

        # Target contained in field
        elif target_text in field_value:

            score += field_score * 0.8

        # Individual target words
        else:

            matched_words = sum(
                1
                for word in target_words
                if word in field_value
            )

            if matched_words:
                score += (
                    field_score *
                    (
                        matched_words /
                        len(target_words)
                    ) *
                    0.6
                )

    # Input fields get a small preference
    if tag in (
        "input",
        "textarea"
    ):
        score += 5

    return score


def find_best_element(
    dom_elements: List[Dict[str, Any]],
    target: str,
    detections: List[Dict[str, Any]],
    require_input: bool = False,
    require_button: bool = False
) -> Optional[Dict[str, Any]]:
    print()
    print("========== DOM ELEMENTS RECEIVED ==========")

    for i, element in enumerate(dom_elements):

        print(
        f"[DOM {i}]",
        {
            "tag": element.get("tag"),
            "type": element.get("type"),
            "role": element.get("role"),
            "text": element.get("text"),
            "text_content": element.get("text_content"),
            "inner_text": element.get("inner_text"),
            "name": element.get("name"),
            "id": element.get("id"),
            "aria-label": element.get("aria-label"),
            "placeholder": element.get("placeholder"),
            "value": element.get("value")
        }
    )

    print("==========================================")
    candidates = []

    print()
    print(
        "[FIND ELEMENT] "
        f"target='{target}' "
        f"require_input={require_input} "
        f"require_button={require_button}"
    )

    # ========================================================
    # CHECK EVERY SAFE DOM ELEMENT
    # ========================================================

    for element in dom_elements:

        tag = str(
            element.get("tag") or ""
        ).lower()

        element_type = str(
            element.get("type") or ""
        ).lower()

        role = str(
            element.get("role") or ""
        ).lower()


        # ====================================================
        # INPUT FILTER
        # ====================================================

        if require_input:

            if tag not in (
                "input",
                "textarea"
            ):
                continue


        # ====================================================
        # BUTTON FILTER
        # ====================================================

        if require_button:

            is_button = (
                tag in (
                    "button",
                    "a"
                )
                or (
                    tag == "input"
                    and element_type in (
                        "submit",
                        "button",
                        "reset"
                    )
                )
                or role in (
                    "button",
                    "link"
                )
            )

            if not is_button:
                continue


        # ====================================================
        # PRIVACY CHECK
        # ====================================================
        #
        # Password / credential / OTP fields are ALWAYS
        # blocked.
        #
        # Other PII-containing editable fields may be used
        # for explicit user-requested local editing.
        #
        # Their existing values are NOT sent in DOM metadata.
        # ====================================================

        is_sensitive = element_is_sensitive(
            element,
            detections
        )

        if is_sensitive:

            element_name = target_name(
                element
            ).lower()

            # ----------------------------------------------
            # HARD BLOCK: PASSWORD / CREDENTIAL / OTP
            # ----------------------------------------------

            if (
                element_type == "password"
                or "password" in element_name
                or "credential" in element_name
                or "otp" in element_name
            ):

                print(
                    "[PRIVACY] BLOCKED sensitive control:",
                    {
                        "tag": tag,
                        "type": element_type,
                        "label": element.get("label"),
                        "text": element.get("text")
                    }
                )

                continue


            # ----------------------------------------------
            # EXPLICIT EDITABLE FIELD
            # ----------------------------------------------
            #
            # For an explicitly requested normal field such
            # as Full Name / Email / Phone, allow target
            # resolution using SAFE DOM metadata.
            #
            # The actual field value is never read here.
            # ----------------------------------------------

            if require_input:

                print(
                    "[PRIVACY] Allowing explicit "
                    "editable-field target resolution:",
                    {
                        "tag": tag,
                        "type": element_type,
                        "label": element.get("label"),
                        "text": element.get("text")
                    }
                )

            else:

                continue


        # ====================================================
        # SCORE TARGET
        # ====================================================

        score = score_element_for_target(
            element,
            target
        )


        # ====================================================
        # ACCEPT CANDIDATE
        # ====================================================

        if score > 0:

            candidates.append(
                (
                    score,
                    element
                )
            )

            # ----------------------------------------------
            # DEBUG LOG
            # ----------------------------------------------

            if require_button:

                print(
                    "[BUTTON CANDIDATE]",
                    {
                        "tag": tag,
                        "type": element_type,
                        "role": role,
                        "label": element.get("label"),
                        "text": element.get("text"),
                        "score": score
                    }
                )

            elif require_input:

                print(
                    "[INPUT CANDIDATE]",
                    {
                        "tag": tag,
                        "type": element_type,
                        "label": element.get("label"),
                        "text": element.get("text"),
                        "score": score
                    }
                )


    # ========================================================
    # NO MATCH
    # ========================================================

    if not candidates:

        print(
            "[FIND ELEMENT] "
            f"No candidate found for target='{target}' "
            f"require_input={require_input} "
            f"require_button={require_button}"
        )

        return None


    # ========================================================
    # SORT BY SCORE
    # ========================================================

    candidates.sort(
        key=lambda item: item[0],
        reverse=True
    )


    # ========================================================
    # BEST MATCH
    # ========================================================

    best_score, best_element = candidates[0]


    print(
        "[FIND ELEMENT] Best match:",
        {
            "target": target,
            "score": best_score,
            "tag": best_element.get("tag"),
            "type": best_element.get("type"),
            "role": best_element.get("role"),
            "label": best_element.get("label"),
            "text": best_element.get("text"),
            "x": best_element.get("x"),
            "y": best_element.get("y")
        }
    )


    return best_element




# ============================================================
# FAST ACTION PLANNER
# ============================================================

def fast_plan(
    task: str,
    dom_elements: List[Dict[str, Any]],
    detections: List[Dict[str, Any]]
) -> Dict[str, Any]:

    start = time.perf_counter()

    print()
    print("==========================================")
    print("[ACTION PLANNER]")
    print("==========================================")
    print("Mode                 : fast")
    print(
        f"Safe DOM elements    : {len(dom_elements)}"
    )
    print(
        f"Local PII detections : {len(detections)}"
    )
    print(
        f"Task                 : {task}"
    )

    t = task_lower(task)

    # --------------------------------------------------------
    # TYPE
    # --------------------------------------------------------

    if is_type_task(task):

        value = extract_explicit_type_value(task)
        target = extract_requested_target(task)

        element = find_best_element(
            dom_elements,
            target,
            detections,
            require_input=True
        )

        if element and value is not None:

            x, y = element_center(element)

            latency = (
                time.perf_counter() - start
            ) * 1000

            print(
                "[FAST PLANNER] "
                f"type target={target or 'input'} "
                f"value_length={len(value)} "
                f"latency={latency:.2f} ms"
            )

            result = {
                "action": "type",
                "x": x,
                "y": y,
                "text": value,
                "amount": 0,
                "confidence": 0.98,
                "reason":
                    f"Matched '{target}' from safe DOM metadata "
                    "and used only the value explicitly supplied "
                    "in the user task.",
                "vlm_latency_ms": round(
                    latency,
                    2
                )
            }

            print(
                f"[FAST] Action: type"
            )
            print(
                f"[FAST] Target: ({x}, {y})"
            )
            print(
                f"[FAST] Confidence: 0.98"
            )
            print(
                f"[FAST] Latency: {latency:.2f} ms"
            )

            return result

        # Explicit type request but no safe field/value.
        latency = (
            time.perf_counter() - start
        ) * 1000

        print(
            "[FAST PLANNER] "
            "type task could not be safely resolved"
        )

        return {
            "action": "none",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": 0,
            "confidence": 0.0,
            "reason":
                "Type task could not be matched to a safe non-sensitive input "
                "using the explicit task value.",
            "vlm_latency_ms": round(
                latency,
                2
            )
        }

    # --------------------------------------------------------
    # SCROLL
    # --------------------------------------------------------

    if (
        "scroll down" in t or
        "scroll downward" in t
    ):

        latency = (
            time.perf_counter() - start
        ) * 1000

        return {
            "action": "scroll",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": 600,
            "confidence": 0.99,
            "reason": "Explicit scroll-down task.",
            "vlm_latency_ms": round(
                latency,
                2
            )
        }

    if (
        "scroll up" in t or
        "scroll upward" in t
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
            "confidence": 0.99,
            "reason": "Explicit scroll-up task.",
            "vlm_latency_ms": round(
                latency,
                2
            )
        }

    # --------------------------------------------------------
    # CLICK
    # --------------------------------------------------------

    target = extract_requested_target(task)

    if (
        "submit" in t and
        not target
    ):
        target = "submit"

    if (
        ("click" in t or
         "press" in t or
         "select" in t) and
        target
    ):

        element = find_best_element(
            dom_elements,
            target,
            detections,
            require_button=(
                target == "submit"
            )
        )

        if element:

            x, y = element_center(element)

            score = score_element_for_target(
                element,
                target
            )

            latency = (
                time.perf_counter() - start
            ) * 1000

            confidence = min(
                0.98,
                max(
                    0.70,
                    0.60 + score / 100.0
                )
            )

            print(
                f"[FAST PLANNER] "
                f"click target={target} "
                f"score={score:.1f} "
                f"latency={latency:.2f} ms"
            )

            print(
                "[FAST] Action: click"
            )
            print(
                f"[FAST] Target: ({x}, {y})"
            )
            print(
                f"[FAST] Confidence: {confidence:.2f}"
            )
            print(
                f"[FAST] Latency: {latency:.2f} ms"
            )

            return {
                "action": "click",
                "x": x,
                "y": y,
                "text": "",
                "amount": 0,
                "confidence": round(
                    confidence,
                    2
                ),
                "reason":
                    f"Matched '{target}' from safe DOM metadata.",
                "vlm_latency_ms": round(
                    latency,
                    2
                )
            }

    # --------------------------------------------------------
    # WAIT
    # --------------------------------------------------------

    if (
        "wait" in t or
        "pause" in t
    ):

        latency = (
            time.perf_counter() - start
        ) * 1000

        return {
            "action": "wait",
            "x": 0,
            "y": 0,
            "text": "",
            "amount": 1000,
            "confidence": 0.99,
            "reason": "Explicit wait task.",
            "vlm_latency_ms": round(
                latency,
                2
            )
        }

    # --------------------------------------------------------
    # FALLBACK
    # --------------------------------------------------------

    latency = (
        time.perf_counter() - start
    ) * 1000

    print(
        "[FAST PLANNER] No safe action matched."
    )

    return {
        "action": "none",
        "x": 0,
        "y": 0,
        "text": "",
        "amount": 0,
        "confidence": 0.0,
        "reason":
            "No safe action could be resolved from the task "
            "and safe DOM metadata.",
        "vlm_latency_ms": round(
            latency,
            2
        )
    }


# ============================================================
# JSON HELPERS FOR QWEN
# ============================================================

def extract_json(text: str) -> Dict[str, Any]:

    text = text.strip()

    try:
        return json.loads(text)
    except Exception:
        pass

    if "```" in text:

        parts = text.split("```")

        for part in parts:

            cleaned = part.strip()

            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()

            try:
                return json.loads(cleaned)
            except Exception:
                continue

    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1:

        candidate = text[
            start:end + 1
        ]

        try:
            return json.loads(candidate)
        except Exception:
            pass

    raise ValueError(
        "Could not parse JSON from VLM response: "
        f"{text[:500]}"
    )


def normalize_action(
    data: Dict[str, Any]
) -> Dict[str, Any]:

    action = str(
        data.get("action", "none")
    ).lower().strip()

    allowed_actions = {
        "click",
        "type",
        "scroll",
        "wait",
        "none"
    }

    if action not in allowed_actions:
        action = "none"

    try:
        x = int(
            data.get("x", 0) or 0
        )
    except Exception:
        x = 0

    try:
        y = int(
            data.get("y", 0) or 0
        )
    except Exception:
        y = 0

    try:
        amount = int(
            data.get("amount", 0) or 0
        )
    except Exception:
        amount = 0

    try:
        confidence = float(
            data.get(
                "confidence",
                0.0
            ) or 0.0
        )
    except Exception:
        confidence = 0.0

    return {
        "action": action,
        "x": x,
        "y": y,
        "text": str(
            data.get("text", "") or ""
        ),
        "amount": amount,
        "confidence": confidence,
        "reason": str(
            data.get(
                "reason",
                "No reason provided"
            )
        )
    }


# ============================================================
# QWEN VISION PATH
# ============================================================

def qwen_plan(
    screenshot_data_url: str,
    detections: List[Dict[str, Any]],
    page_url: str,
    dom_elements: List[Dict[str, Any]],
    task: str
) -> Dict[str, Any]:

    start_time = time.perf_counter()

    encoded_image = screenshot_data_url

    if "," in encoded_image:

        _, encoded_image = (
            encoded_image.split(",", 1)
        )

    print()
    print("==========================================")
    print("[VLM REQUEST]")
    print("==========================================")

    print(
        f"[VLM] Sanitized image size: "
        f"{len(encoded_image) / 1024:.1f} KB"
    )

    optimized_image = optimize_image(
        encoded_image
    )

    compact_dom = []

    for element in dom_elements[:20]:

        compact_dom.append({

            "tag": element.get("tag"),
            "type": element.get("type"),
            "label": element.get("label"),
            "text": element.get("text"),
            "aria": element.get("aria"),
            "placeholder":
                element.get("placeholder"),
            "x": element.get("x"),
            "y": element.get("y"),
            "width": element.get("width"),
            "height": element.get("height")
        })

    compact_detections = []

    for detection in detections[:20]:

        compact_detections.append({

            "type": detection.get("type"),
            "x": detection.get("x"),
            "y": detection.get("y"),
            "width": detection.get("width"),
            "height": detection.get("height")
        })

    user_prompt = f"""
Task:
{task}

Page:
{page_url}

Safe DOM elements:
{json.dumps(
    compact_dom,
    separators=(",", ":")
)}

Local privacy detections:
{json.dumps(
    compact_detections,
    separators=(",", ":")
)}

Choose the safest useful browser action.
For a type task, use ONLY the explicitly quoted value from the Task.
Return ONLY JSON.
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

        "keep_alive": "10m",

        "options": {
            "temperature": 0,
            "num_ctx": 1024,
            "num_predict": 48
        }
    }

    print(
        "[VLM] Sending optimized image "
        "to Ollama..."
    )

    try:

        response = requests.post(
            OLLAMA_URL,
            json=payload,
            timeout=OLLAMA_TIMEOUT
        )

    except requests.exceptions.Timeout:

        elapsed = (
            time.perf_counter()
            - start_time
        ) * 1000

        raise RuntimeError(
            "Ollama vision inference timed out "
            f"after {elapsed / 1000:.1f} seconds."
        )

    except requests.exceptions.ConnectionError as exc:

        raise RuntimeError(
            "Cannot connect to Ollama at "
            "http://127.0.0.1:11434"
        ) from exc

    except Exception as exc:

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

        ollama_data = response.json()

    except Exception as exc:

        raise RuntimeError(
            f"Invalid JSON returned by Ollama: {exc}"
        )

    content = (
        ollama_data
        .get("message", {})
        .get("content", "")
    )

    if not content:

        raise RuntimeError(
            "Ollama returned no model content."
        )

    print()
    print("==========================================")
    print("[VLM RAW RESPONSE]")
    print("==========================================")
    print(content)

    parsed = extract_json(content)

    action = normalize_action(
        parsed
    )

    elapsed = (
        time.perf_counter()
        - start_time
    ) * 1000

    print(
        f"[VLM] Action: {action['action']}"
    )
    print(
        f"[VLM] Confidence: "
        f"{action['confidence']:.2f}"
    )
    print(
        f"[VLM] Total latency: "
        f"{elapsed:.0f} ms"
    )

    return {
        **action,
        "vlm_latency_ms": round(
            elapsed,
            2
        )
    }


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def analyze_screenshot(
    screenshot_data_url: str,
    detections: list,
    page_url: str,
    dom_elements: list,
    task: str
) -> Dict[str, Any]:

    if not screenshot_data_url:
        raise ValueError(
            "No sanitized screenshot received."
        )

    task = normalize_text(
        task
    ) or "Choose the safest useful action."

    # Fast mode is used for the live demo.
    if VLM_MODE == "fast":

        return fast_plan(
            task=task,
            dom_elements=dom_elements or [],
            detections=detections or []
        )

    # Qwen mode remains available for visual benchmarking.
    if VLM_MODE in (
        "qwen",
        "ollama",
        "vision"
    ):

        return qwen_plan(
            screenshot_data_url=
                screenshot_data_url,
            detections=detections or [],
            page_url=page_url or "",
            dom_elements=dom_elements or [],
            task=task
        )

    raise ValueError(
        f"Unsupported VLM_MODE: {VLM_MODE}. "
        "Use 'fast' or 'qwen'."
    )
