# uRvault — Solo Build Plan (with Sub-Phases)
### On-device Visual Perception for Light-weight Browser Agents — if I have to build this alone

**Org:** ISRO / Dept. of Space &nbsp;|&nbsp; **Category:** Software &nbsp;|&nbsp; **Theme:** Smart Automation

---

Six phases, strictly sequential — each broken into sub-phases so there's always a next concrete step instead of a vague block of work. Sub-phases inside a phase can be reordered slightly if needed, but phases themselves cannot: don't start Phase 2 sub-phases before Phase 1 is fully exited.

---

## Must Keep vs. Cut or Defer

| Keep (this is what scores points) | Cut or defer (stretch only, if time remains) |
|---|---|
| DOM-based PII heuristics — cheapest, highest return for the 20% detection metric | Custom-trained or fine-tuned models — pretrained/quantized off-the-shelf only |
| One small local vision model for screen understanding (25% metric) | Firefox support — Chrome-only first, port later if time allows |
| Black-box redaction, DOM + canvas level | Hybrid local/server fallback logic |
| FastAPI + Qwen2-VL cloud API integration | A polished live dashboard — a plain numbers readout is enough |
| A small, self-made labeled test set (10–15 pages) | Multiple alternative VLM benchmarking — pick one server model |
| A basic benchmarking script for latency + precision/recall | Distillation/quantization research beyond one INT8 pass |

---

## Phase 0 — Scope Lock
*A few hours, before any code.*

- **0.1 PS & Rubric Review** — re-read the PS once more; write the five evaluation weights (25/20/20/20/15) somewhere visible daily.
- **0.2 Demo Task Lock** — fix one ISRO-relevant form with 2–3 sensitive fields (ID number, bank details); this is the only task you build and benchmark against.
- **0.3 Browser & Model Decisions** — Chrome-only for the build (Firefox is stretch); DOM heuristics + regex for text PII; one quantized local vision model (MobileViT or YOLOv8n) via ONNX Runtime Web; BlazeFace for faces; Qwen2-VL via cloud API on the server.
- **0.4 Seed Test Set** — capture 10–15 screenshots of the demo task plus a couple of PII edge cases; mark sensitive regions by hand. Feeds Phase 3 benchmarking.

**Exit criteria:** demo task, browser target, and model choices are written down; the seed test set exists.

---

## Phase 1 — Core Loop (DOM Only)
*Highest-priority phase — get one task working end to end before any vision model.*

- **1.1 Extension Shell** — Manifest V3 scaffold, Chrome target, basic content script + background worker wiring.
- **1.2 Capture & DOM Extraction** — screen capture (`chrome.tabCapture` or `html2canvas`) plus DOM tree extraction running together on the target page.
- **1.3 DOM-Based PII Detection** — flag `type="password"`, `autocomplete="cc-number"/"email"`, and run regex over text nodes for card numbers, emails, phone numbers, Aadhaar-pattern numbers.
- **1.4 DOM/Canvas Redaction** — black-box the flagged elements before any serialization; confirm nothing sensitive leaks into the payload.
- **1.5 Backend & Protocol** — stand up FastAPI, integrate Qwen2-VL, define the sanitized-payload + structured-action JSON schema.
- **1.6 Action Execution** — extension receives `{"action": "...", "target": "..."}` and performs the click/type/scroll.
- **1.7 End-to-End Wiring** — connect 1.1–1.6 into one loop and run the fixed demo task start to finish.

**Exit criteria:** the demo task runs end to end with DOM-only redaction; sensitive fields are visibly blacked out while the form still gets filled.

---

## Phase 2 — Visual Layer
*The 25% metric — the single biggest line item in the rubric.*

- **2.1 Local Vision Model Integration** — load the quantized MobileViT/YOLOv8n model via ONNX Runtime Web; run it against a captured screenshot and inspect the raw output.
- **2.2 Face Detection** — integrate BlazeFace as a second, independent detection signal alongside the DOM path.
- **2.3 Visual Redaction Extension** — extend the redaction step to canvas/pixel level for anything DOM heuristics can't see (images, canvas-rendered text, faces).
- **2.4 Dual-Signal Merge** — combine DOM-path and vision-path detections into one redaction pass so neither path silently overrides the other.

**Exit criteria:** the local model's screen-understanding output is visually sane; visual PII gets redacted alongside DOM-based PII, not instead of it.

---

## Phase 3 — Benchmark & Tune
*You're the builder and the tester now — keep this lightweight.*

- **3.1 Benchmark Harness** — write latency timers around each pipeline stage and hook into `performance.memory` for RAM.
- **3.2 Accuracy Scoring** — score detection recall/precision and redaction precision as two separate numbers against the Phase 0 test set.
- **3.3 Quantization Pass** — apply one INT8 pass to the local models; re-run 3.2 to confirm accuracy still holds.
- **3.4 Threshold Tuning** — adjust PII detection thresholds based on what 3.2 actually shows, not intuition.

**Exit criteria:** real numbers exist for all five rubric metrics; final threshold settings are locked and documented.

---

## Phase 4 — Minimal UI & Demo Assets
*Functional beats polished — don't let this phase expand.*

- **4.1 Popup UI** — task input, start button, and status rows for perception/redaction/reasoning.
- **4.2 Before/After Toggle** — the raw vs. redacted side-by-side view; still your single best demo visual.
- **4.3 Stats Readout** — a plain panel showing latency, fields redacted, and RAM, pulled straight from the Phase 3 harness.

**Exit criteria:** the UI shows what's happening without narration; this phase didn't outrun Phase 1 or Phase 2 in time spent.

---

## Phase 5 — Hardening & Demo Prep
*Reliability over new features from here on.*

- **5.1 Bug-Fixing Pass** — resolve everything found while dry-running the demo repeatedly; this comes before anything else in this phase.
- **5.2 Stretch: Firefox Port** — attempt only if 5.1 is solid with real time to spare.
- **5.3 Backup Assets** — record a full backup demo video in case live network or hardware fails.
- **5.4 Rehearsal** — run the exact demo out loud, on presentation hardware, at least three times.
- **5.5 Q&A Prep** — write a one-sentence justification for every item on the "cut or defer" list, since a solo build invites that question directly.

**Exit criteria:** the demo has succeeded three times in a row, unassisted, on the machine you'll present from.

---

> **The rule that overrides all of the above:** a smaller pipeline that works completely beats a bigger one that's 80% done in every direction. If you fall behind at any phase boundary, cut from the deferred list — never compress Phase 1 or Phase 2, since those carry the biggest rubric weights.
