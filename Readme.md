# SIH Task Documentation — Per Person

Sarvam AI dropped. Server model: **Qwen2-VL** (primary, cloud-hosted during SIH). Latency optimization = model quantization/distillation research, not a model-brand swap.

---

## Tech Stack

| Layer | Stack |
|---|---|
| Extension | JS/TS, Manifest V3 (Chrome), WebExtensions API (Firefox) |
| Local inference | ONNX Runtime Web / Transformers.js, WebGPU with WASM fallback |
| Local CV models | Quantized YOLOv8n or MobileViT (region/UI detection), BlazeFace (face detection) |
| OCR | Tesseract.js or PaddleOCR-onnx |
| PII detection | Regex + small distilled NER model |
| Redaction | Canvas pixel manipulation (black-box), DOM value stripping |
| Server | Python, FastAPI |
| Server model | Qwen2-VL (cloud API during SIH; self-hosted if time allows) |
| Protocol | JSON schema (sanitized payload + structured action response) |
| Benchmarking | Custom latency timers, `performance.memory`, CPU/GPU logging |

---

## People Needed (mapped to your team)

| Skill | Person |
|---|---|
| Browser/extension engineering | Ashutosh |
| Frontend/UI/UX + product | Lucky |
| CV/ML + backend/VLM (joint) | Vansh & Hasnain |
| Testing/benchmarking | Janmejay |

---

## Ashutosh — Browser/Extension (individual)

**Phase 1**
- Build extension shell: Manifest V3 + Firefox WebExtensions compatibility.
- Implement screen capture (`chrome.tabCapture` or DOM-to-canvas via `html2canvas`).
- Extract raw DOM tree, pass to Vansh/Hasnain's detection module.
- Build overlay UI hook (placeholder box where redaction will render).

**Phase 2**
- Implement action executor: receive `{"action":"click","target":"#id"}`-style JSON from server, execute via content script / `chrome.debugger`.
- Handle failure cases (element not found, ambiguous target, retry logic).

**Phase 3**
- Cross-browser bug fixes (Chrome vs Firefox capture/execution differences).
- Support integration testing with Janmejay.

---

## Lucky — Frontend/Product (individual)

**Phase 1**
- Build extension popup/floating agent UI.
- Build "before vs. after" redaction toggle view (raw vs. redacted side-by-side) — this is your primary demo asset.

**Phase 2**
- Build live metrics dashboard: latency per stage, CPU/GPU/memory usage, PII precision/recall — pull numbers from Janmejay's benchmark harness.
- Polish UX for the end-to-end task demo flow.

**Phase 3**
- Final UI polish for pitch/demo day.
- Support Janmejay in visualizing benchmark comparisons (Phase 1 model vs. Phase 2 optimized model).

---

## Vansh & Hasnain — Privacy/ML + Backend/VLM + Latency Research (joint)

**Phase 1 — Build working pipeline (correctness first)**
- PII taxonomy: define exact classes (passwords, faces, card numbers, emails, phone, Aadhaar-pattern numbers).
- DOM heuristics: flag `type="password"`, `autocomplete="cc-number"/"email"` tags (cheap, do first).
- OCR integration: extract text from images/canvas.
- Local CV model: face detection + generic region detection (bounding boxes).
- Redaction: black-box (not blur) over flagged regions — apply before serialization.
- Backend: FastAPI server, integrate Qwen2-VL, define JSON payload schema (sanitized image/text + redaction map).
- Structured action generation: server returns `{"action": "...", "target": "..."}`.
- **Exit criteria:** one full task (e.g. form fill) works end-to-end with visible before/after redaction.

**Phase 2 — Latency research (no Sarvam)**
- Benchmark smaller/quantized VLM alternatives against Qwen2-VL baseline: Qwen2-VL-2B, MiniCPM-V, Moondream2, Florence-2 — measure latency vs. task accuracy trade-off for each.
- Test quantization (int8) on your local CV models to cut client-side inference time.
- Test payload-size reduction: structured JSON (OCR text + element list + positions) instead of full image, where feasible, to cut network+server latency.
- Tune PII detection thresholds against Janmejay's test set to balance precision/recall.
- **Exit criteria:** documented latency numbers for at least 2 alternative configs vs. Phase 1 baseline, with a recommendation on which to demo.

**Phase 3 — Only if time remains**
- Hybrid fallback: small local model handles simple/ambiguous cases, escalate to server VLM only when needed.
- Final redaction precision tuning based on Janmejay's last benchmark pass.

---

## Janmejay — Testing/Evaluation

**Phase 1**
- Build test webpage set: login form, page with photo, government-style form with structured PII fields.
- Build labeled PII dataset (self-generated) for precision/recall scoring.

**Phase 2**
- Run latency/resource benchmarks on each model config Vansh & Hasnain produce.
- Score redaction precision, PII recall/precision, task success rate against the test set.

**Phase 3**
- Final full-pipeline benchmark pass before demo.
- Hand Lucky the final numbers for the dashboard.
- Prep the "raw vs. redacted network payload" live proof for pitch day.

---

## Sequencing

```
Phase 1: All 4 build in parallel toward one working end-to-end task.
Phase 2: Vansh & Hasnain run latency research; Janmejay benchmarks each config; Lucky builds dashboard from real numbers.
Phase 3: Integration hardening, final tuning, demo rehearsal.
```

Do not start Phase 2 latency work until Phase 1's single end-to-end task is fully working.
