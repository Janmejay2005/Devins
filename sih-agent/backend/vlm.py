import base64
import io
import json
import time
from typing import Any, Dict

import requests
from PIL import Image


OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen2.5vl:3b"
OLLAMA_TIMEOUT = 300


SYSTEM_PROMPT = """
You are a browser computer-use agent.

You receive:
1. A SANITIZED screenshot.
2. Safe DOM metadata.
3. A browser task.

IMPORTANT:
The screenshot has already been sanitized locally.
Never request or expose sensitive information.

Choose ONE safest useful browser action.

Allowed actions:
- click
- type
- scroll
- wait
- none

Return ONLY valid JSON in this exact structure:

{
  "action": "click",
  "x": 100,
  "y": 100,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": "short explanation"
}

For click:
x and y are viewport coordinates.

For type:
text must not contain sensitive information.

For scroll:
amount is positive or negative.

If uncertain, use action "none".

Keep the response extremely short.
"""


def optimize_image(encoded_image: str) -> str:
    """
    Resize the already-sanitized screenshot before
    sending it to the local VLM.
    """

    try:
        image_bytes = base64.b64decode(encoded_image)

        image = Image.open(io.BytesIO(image_bytes))

        print(
            f"[VLM] Original image: "
            f"{image.width}x{image.height}"
        )

        max_width = 768
        max_height = 768

        image.thumbnail(
            (max_width, max_height),
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
            quality=65,
            optimize=True
        )

        optimized_bytes = output.getvalue()

        print(
            f"[VLM] Optimized image size: "
            f"{len(optimized_bytes) / 1024:.1f} KB"
        )

        return base64.b64encode(
            optimized_bytes
        ).decode("utf-8")

    except Exception as exc:

        print(
            f"[VLM] Image optimization failed: {exc}"
        )

        return encoded_image


def extract_json(text: str) -> Dict[str, Any]:

    text = text.strip()

    # Direct JSON
    try:
        return json.loads(text)
    except Exception:
        pass

    # Markdown code block
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

    # Find JSON object
    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1:

        candidate = text[start:end + 1]

        try:
            return json.loads(candidate)
        except Exception:
            pass

    raise ValueError(
        f"Could not parse JSON from VLM response: "
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
        x = int(data.get("x", 0) or 0)
    except Exception:
        x = 0

    try:
        y = int(data.get("y", 0) or 0)
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
            data.get("confidence", 0.0) or 0.0
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


def analyze_screenshot(
    screenshot_data_url: str,
    detections: list,
    page_url: str,
    dom_elements: list,
    task: str
) -> Dict[str, Any]:

    start_time = time.perf_counter()

    # --------------------------------------------------
    # Validate screenshot
    # --------------------------------------------------

    if not screenshot_data_url:

        raise ValueError(
            "No sanitized screenshot received."
        )

    # --------------------------------------------------
    # Remove data URL prefix if present
    # --------------------------------------------------

    encoded_image = screenshot_data_url

    if "," in encoded_image:

        prefix, encoded_image = encoded_image.split(
            ",",
            1
        )

    print(
        "\n=========================================="
    )
    print(
        "[VLM REQUEST]"
    )
    print(
        "=========================================="
    )

    print(
        f"[VLM] Sanitized image size: "
        f"{len(encoded_image) / 1024:.1f} KB"
    )

    # --------------------------------------------------
    # Optimize screenshot
    # --------------------------------------------------

    optimized_image = optimize_image(
        encoded_image
    )

    # --------------------------------------------------
    # Compact DOM metadata
    # --------------------------------------------------

    compact_dom = []

    for element in dom_elements[:20]:

        compact_dom.append({

            "tag": element.get("tag"),

            "type": element.get("type"),

            "text": element.get("text"),

            "aria": element.get("aria"),

            "placeholder": element.get(
                "placeholder"
            ),

            "x": element.get("x"),

            "y": element.get("y"),

            "width": element.get(
                "width"
            ),

            "height": element.get(
                "height"
            )
        })

    # --------------------------------------------------
    # Compact detection metadata
    # --------------------------------------------------

    compact_detections = []

    for detection in detections[:20]:

        compact_detections.append({

            "type": detection.get(
                "type"
            ),

            "x": detection.get(
                "x"
            ),

            "y": detection.get(
                "y"
            ),

            "width": detection.get(
                "width"
            ),

            "height": detection.get(
                "height"
            )
        })

    # --------------------------------------------------
    # Prompt
    # --------------------------------------------------

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

Return ONLY JSON.
"""

    # --------------------------------------------------
    # Ollama request
    # --------------------------------------------------

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

            "num_ctx": 2048,

            "num_predict": 96
        }
    }

    print(
        "[VLM] Sending optimized image to Ollama..."
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

        print(
            "[VLM ERROR] Ollama request timed out "
            f"after {elapsed:.0f} ms."
        )

        raise RuntimeError(
            "Ollama vision inference timed out "
            f"after {elapsed / 1000:.1f} seconds."
        )

    except requests.exceptions.ConnectionError as exc:

        print(
            "[VLM ERROR] Cannot connect to Ollama:"
        )

        print(exc)

        raise RuntimeError(
            "Cannot connect to Ollama at "
            "http://127.0.0.1:11434"
        )

    except Exception as exc:

        print(
            f"[VLM ERROR] Request failed: {exc}"
        )

        raise RuntimeError(
            f"Ollama request failed: {exc}"
        )

    # --------------------------------------------------
    # HTTP status
    # --------------------------------------------------

    if response.status_code != 200:

        print(
            f"[VLM ERROR] HTTP "
            f"{response.status_code}"
        )

        print(
            response.text[:2000]
        )

        raise RuntimeError(
            f"Ollama returned HTTP "
            f"{response.status_code}: "
            f"{response.text[:500]}"
        )

    # --------------------------------------------------
    # Parse Ollama response
    # --------------------------------------------------

    try:

        ollama_data = response.json()

    except Exception as exc:

        raise RuntimeError(
            f"Invalid JSON returned by Ollama: "
            f"{exc}"
        )

    message = ollama_data.get(
        "message",
        {}
    )

    content = message.get(
        "content",
        ""
    )

    if not content:

        raise RuntimeError(
            "Ollama returned no model content."
        )

    print(
        "\n=========================================="
    )
    print(
        "[VLM RAW RESPONSE]"
    )
    print(
        "=========================================="
    )

    print(content)

    # --------------------------------------------------
    # Extract action
    # --------------------------------------------------

    parsed = extract_json(
        content
    )

    action = normalize_action(
        parsed
    )

    elapsed = (
        time.perf_counter()
        - start_time
    ) * 1000

    print(
        f"[VLM] Action: "
        f"{action['action']}"
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