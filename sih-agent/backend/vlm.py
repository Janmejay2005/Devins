import base64
import io
import json
import time
from typing import Any, Dict

import requests
from PIL import Image


OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen2.5vl:3b"

# Keep this reasonably high so the request doesn't fail prematurely,
# but the real optimization is image/context reduction.
OLLAMA_TIMEOUT = 300


SYSTEM_PROMPT = """
You are a browser computer-use agent.

You receive:
1. A SANITIZED screenshot.
2. Safe DOM metadata.
3. A user task.

IMPORTANT PRIVACY RULE:
The screenshot has already been sanitized locally.
Never ask for or infer hidden sensitive values.

Choose ONE safest useful browser action.

Allowed actions:
- click
- type
- scroll
- wait
- none

Return ONLY valid JSON:

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
- x and y are viewport coordinates.

For type:
- text must be non-sensitive.

For scroll:
- amount should be positive or negative.

If unsure, use:
{
  "action": "none",
  "x": 0,
  "y": 0,
  "text": "",
  "amount": 0,
  "confidence": 0.0,
  "reason": "uncertain"
}

Keep the response extremely short.
"""


def optimize_image(encoded_image: str) -> str:
    """
    Decode the sanitized screenshot and resize it before sending
    to the local VLM.

    This reduces visual tokens and CPU/GPU inference cost.
    """

    try:
        image_bytes = base64.b64decode(encoded_image)

        image = Image.open(io.BytesIO(image_bytes))

        print(
            f"[VLM] Original image: "
            f"{image.width}x{image.height}"
        )

        # Keep screenshot reasonably small for local 3B VLM inference.
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

        output = io.BytesIO()

        # JPEG is much smaller and sufficient for visual grounding.
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")

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

        return base64.b64encode(optimized_bytes).decode("utf-8")

    except Exception as exc:
        print(f"[VLM] Image optimization failed: {exc}")

        # Fall back to original image.
        return encoded_image


def extract_json(text: str) -> Dict[str, Any]:
    """
    Extract JSON from the VLM response.
    """

    text = text.strip()

    # Direct JSON
    try:
        return json.loads(text)
    except Exception:
        pass

    # JSON inside markdown/code fences
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

    # Find first JSON object
    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1 and end > start:
        candidate = text[start:end + 1]

        try:
            return json.loads(candidate)
        except Exception:
            pass

    raise ValueError(
        f"Could not parse JSON from VLM response: {text[:500]}"
    )


def normalize_action(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Make sure the returned action always follows our protocol.
    """

    action = str(data.get("action", "none")).lower().strip()

    allowed = {
        "click",
        "type",
        "scroll",
        "wait",
        "none"
    }

    if action not in allowed:
        action = "none"

    result = {
        "action": action,
        "x": int(data.get("x", 0) or 0),
        "y": int(data.get("y", 0) or 0),
        "text": str(data.get("text", "") or ""),
        "amount": int(data.get("amount", 0) or 0),
        "confidence": float(data.get("confidence", 0.0) or 0.0),
        "reason": str(
            data.get("reason", "No reason provided")
        )
    }

    return result


def analyze_screenshot(
    encoded_image: str,
    detections: list,
    page_url: str,
    dom_elements: list,
    task: str
) -> Dict[str, Any]:

    start_time = time.perf_counter()

    if not encoded_image:
        raise ValueError("No sanitized screenshot received.")

    print(
        f"[VLM] Sanitized image size: "
        f"{len(encoded_image) / 1024:.1f} KB"
    )

    # ---------------------------------------------------------
    # 1. Optimize screenshot locally
    # ---------------------------------------------------------

    optimized_image = optimize_image(encoded_image)

    # ---------------------------------------------------------
    # 2. Keep DOM context compact
    # ---------------------------------------------------------

    compact_dom = []

    for element in dom_elements[:20]:
        compact_dom.append({
            "tag": element.get("tag"),
            "type": element.get("type"),
            "text": element.get("text"),
            "aria": element.get("aria"),
            "placeholder": element.get("placeholder"),
            "x": element.get("x"),
            "y": element.get("y"),
            "width": element.get("width"),
            "height": element.get("height")
        })

    # ---------------------------------------------------------
    # 3. Keep detection metadata compact
    # ---------------------------------------------------------

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
{json.dumps(compact_dom, separators=(",", ":"))}

Local privacy detections:
{json.dumps(compact_detections, separators=(",", ":"))}

Choose the safest useful browser action.

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

        # Keep model loaded between requests.
        "keep_alive": "10m",

        "options": {
            "temperature": 0,
            "num_ctx": 2048,
            "num_predict": 96
        }
    }

    print("[VLM] Sending optimized image to Ollama...")

    try:

        response = requests.post(
            OLLAMA_URL,
            json=payload,
            timeout=OLLAMA_TIMEOUT
        )

    except requests.exceptions.Timeout:

        elapsed = (
            time.perf_counter() - start_time
        ) * 1000

        print(
            f"[VLM ERROR] Ollama timed out "
            f"after {elapsed:.0f} ms"
        )

        raise RuntimeError(
            f"Ollama vision inference timed out "
            f"after {elapsed / 1000:.1f} seconds."
        )

    except requests.exceptions.ConnectionError as exc:

        print(
            f"[VLM ERROR] Cannot connect to Ollama: {exc}"
        )

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

    # ---------------------------------------------------------
    # HTTP error
    # ---------------------------------------------------------

    if response.status_code != 200:

        print(
            f"[VLM ERROR] HTTP {response.status_code}"
        )

        print(
            response.text[:2000]
        )

        raise RuntimeError(
            f"Ollama returned HTTP "
            f"{response.status_code}: "
            f"{response.text[:500]}"
        )

    # ---------------------------------------------------------
    # Parse Ollama response
    # ---------------------------------------------------------

    try:

        ollama_data = response.json()

    except Exception as exc:

        raise RuntimeError(
            f"Invalid JSON returned by Ollama: {exc}"
        )

    message = ollama_data.get("message", {})

    content = message.get("content", "")

    if not content:

        raise RuntimeError(
            f"Ollama returned no content: "
            f"{ollama_data}"
        )

    print(
        "\n[VLM RAW RESPONSE]"
    )

    print(content)

    print(
        "\n[VLM] Parsing action..."
    )

    parsed = extract_json(content)

    action = normalize_action(parsed)

    elapsed = (
        time.perf_counter() - start_time
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
        "vlm_latency_ms": round(elapsed, 2)
    }