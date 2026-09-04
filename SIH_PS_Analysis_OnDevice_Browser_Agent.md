# 🛰️ SIH Problem Statement Deep-Dive
## On-device Visual Perception for Light-weight Browser Agents
**Organization:** ISRO / Department of Space · **Category:** Software · **Theme:** Smart Automation

---

## 1️⃣ Pain Points & Core Understanding 🔎

### 🎯 What exact problem is being addressed?
The PS asks for a **browser-native, privacy-preserving vision agent** — a system that:
- "Reads" the user's screen locally using a lightweight vision model (ViT-class) running via **WebGPU/WASM**.
- **Never sends raw screen pixels** containing sensitive data (passwords, faces, PII, financial info) to a server.
- Locally **detects and redacts** sensitive regions (blur/black-box/mask).
- Sends only the **sanitized visual/structural context** to a cloud/server-side LLM or VLM.
- Receives back an **actionable command** (click, scroll, type) that the browser extension executes — closing the agentic loop.

In short: **"Computer-use agent, but the eyes stay local and blind spots are enforced by design."**

### 🌱 Why does this problem exist (root causes)?
| Root Cause | Explanation |
|---|---|
| **Agent architecture assumption** | Most agentic frameworks (Operator, Project Mariner, Claude Computer Use) assume the model itself sees the full screenshot — trust is placed entirely in the vendor's server-side handling. |
| **Resource asymmetry** | Full VLMs (7B–70B parameters) can't run at usable latency on consumer laptops/phones — hence screen data *has* to leave the device today. |
| **No sensitivity-aware capture layer** | Browsers/OS screenshot APIs are "dumb" — they capture pixels, not semantics. There's no standard layer that classifies what's sensitive *before* capture leaves the sandbox. |
| **Regulatory pressure** | GDPR/DPDP-style data-minimization laws increasingly forbid sending identifiable personal data to third-party inference endpoints without explicit justification. |

### 👥 Primary stakeholders/users
- **End users / citizens** using agentic browser assistants for everyday tasks (forms, banking, e-governance portals).
- **Enterprises** wanting AI copilots on internal dashboards without leaking customer PII to external LLM APIs.
- **Government / ISRO-linked systems** — internal tools, e-governance, and citizen-facing portals (e.g., MOSDAC, Bhuvan, Aadhaar-linked forms) where visual agents assisting users must not leak Aadhaar numbers, OTPs, or biometric previews.
- **Browser vendors & extension developers** (Chrome/Firefox) who need a reference privacy-preserving agent architecture.

### ⚠️ Current challenges / inefficiencies
- Existing browser agents (Nanobrowser, Browser-Use, OpenAI Operator, Project Mariner) send **screenshots or DOM dumps wholesale** to a cloud LLM — no client-side redaction layer exists in any mainstream tool today.
- On-device vision models are fast improving (Transformers.js v3/v4, ONNX Runtime Web) but **PII-detection-grade accuracy at low latency** is still an open research problem, especially for unstructured visual PII (faces, ID cards, handwriting) vs. structured PII (form fields).
- **DOM-based redaction is inherently incomplete** — text baked into `<canvas>`, images, or PDFs embedded in a page won't show up in DOM tags and needs actual pixel-level CV.
- No standard **"redaction-aware" protocol** exists between client and server — the server needs to be redaction-scheme-aware, which is a genuinely novel systems-design requirement in this PS.

---

## 2️⃣ Feasibility of Execution ⚙️

### ✅ Can a working prototype be built in hackathon time?
**Yes — a scoped-down MVP is realistic in 30–36 hours**, provided the team doesn't try to train models from scratch and instead composes existing pretrained components. Full production-grade redaction (25%+20%+20% of evaluation weight) is the hard part — budget most of your time there, not on the LLM backend.

### 🔧 Technical requirements
| Layer | Suggested Stack |
|---|---|
| **Browser capture** | Chrome Extension `chrome.tabCapture` / `desktopCapture`, or `MutationObserver` + `html2canvas` for DOM-only mode |
| **Local inference runtime** | **ONNX Runtime Web** (WebGPU backend) or **Transformers.js v3/v4** — both run ONNX models client-side with WASM fallback |
| **Local vision model** | Small ViT/YOLO-class detector: e.g., quantized **YOLOv8n-face**, **BlazeFace** (face detection), a distilled **DETR/OWL-ViT** for generic object/PII-region detection, or a fine-tuned lightweight **LayoutLM-style** model for form-field classification |
| **PII/NER for on-screen text** | OCR (Tesseract.js / PaddleOCR-onnx) + a small NER model (regex + distilled BERT for entities: email, phone, Aadhaar-like numbers, card numbers) |
| **Redaction mechanism** | Canvas-based blur/black-box overlay, or DOM attribute tagging (`aria-hidden`, custom `data-sensitive` tags) stripped before serialization |
| **Server-side VLM** | Any open-weight VLM (LLaVA-OneVision, Qwen2-VL, InternVL2, MiniCPM-V) self-hosted, or cloud API during SIH judging (as PS explicitly permits) |
| **Client↔server protocol** | JSON schema carrying: sanitized screenshot / redacted DOM tree + bounding-box metadata + task instruction |
| **Action execution** | `chrome.debugger` / content-script DOM manipulation to simulate clicks, scrolls, keystrokes |

### 🚧 Likely blockers
- **Latency stacking**: capture → local inference → redaction → network round trip → server VLM → response → DOM action. Each hop adds latency; end-to-end latency is 15% of evaluation — budget time for a caching/streaming strategy.
- **WebGPU browser support variance** — must implement WASM fallback (per PS: "popular browsers Chrome, Firefox" — Firefox's WebGPU rollout is newer/less stable).
- **Dataset scarcity** for "screen PII" specifically — no large public "redact this screenshot" benchmark exists; teams will need synthetic data (self-generated screenshots with injected fake PII) for evaluation/demo.
- **False positives/negatives in redaction** — over-redacting breaks task usability (agent can't read the button it needs), under-redacting leaks data. This precision/recall trade-off is literally 40% of the scoring (PII detection + redaction precision combined).
- **Cross-origin / extension permission restrictions** in Manifest V3 (Chrome) can block some capture approaches.

### 🏆 MVP to impress evaluators
1. Chrome extension captures a visible tab screenshot.
2. Local ONNX ViT/YOLO model detects: (a) generic UI structure/buttons, (b) sensitive regions — faces, password fields (via `type="password"` + visual cue), card-number-shaped text blocks.
3. Local redaction overlay (blur/black box) is visibly demonstrated in the popup UI — **this visual "before/after" demo is a huge scoring lever** since two evaluation criteria are about redaction quality.
4. Sanitized image + structural JSON sent to a self-hosted or cloud VLM (e.g., Qwen2-VL via free-tier API) with a task like *"help me fill this form."*
5. Server returns a structured action (`{"action":"click","target":"#submit-btn"}`), which the extension executes.
6. Dashboard showing latency breakdown + client resource usage (CPU/GPU %, memory) — **directly demonstrates 2 of the 5 scoring metrics live**, which is a strong differentiator.

---

## 3️⃣ Impact & Relevance 🌍

### 👥 Who benefits
- **Citizens** using government/e-commerce/banking portals with AI help, without exposing Aadhaar, OTPs, or financial data to third-party cloud LLMs.
- **Enterprises & government IT** deploying AI copilots on sensitive internal dashboards (HR, health records, defense/space-program consoles) where sending screen data externally is a compliance non-starter.
- **Accessibility users** — a privacy-safe on-screen agent can double as a robust assistive-technology layer for visually impaired or motor-impaired users navigating complex sites.
- **ISRO / Dept. of Space specifically**: internal portals (personnel systems, satellite-ops dashboards, MOSDAC/Bhuvan geoportals) could use such an agent for automation without exporting classified/sensitive imagery or telemetry screens to third-party AI vendors.

### 📈 Real-world impact
- **Economic**: reduces enterprise AI-adoption friction caused by data-residency and compliance blockers — unlocks agentic AI in regulated sectors (BFSI, healthcare, govt).
- **Social**: builds public trust in AI browser agents at a moment when "agentic browsers" (Comet, ChatGPT Atlas, Edge Copilot) are becoming default consumer software.
- **Environmental/efficiency**: hybrid architecture reduces server-side compute load per request vs. sending full-resolution video/screenshots continuously — smaller, structured payloads.

### 📊 Scalability beyond hackathon
- Directly generalizable to a **browser-vendor-level privacy API** (analogous to Chrome's "Built-in AI"/Gemini Nano initiative) — could become a proposed **W3C-style standard for "redaction-aware agent protocols."**
- State/national-level use: e-governance portals (UMANG, DigiLocker, income-tax portal) could embed this as a "safe AI assist" layer.
- Enterprise licensing potential as a **B2B privacy-compliance SDK** for any company building AI copilots on top of sensitive dashboards.

### 🎯 Why evaluators find this important
- Sits squarely in the **"privacy-by-design AI infrastructure"** trend — a genuinely underserved gap (no major browser agent today does true local redaction).
- ISRO/Govt context implies strong interest in **sovereign, on-device AI** that reduces dependency on foreign cloud AI vendors for sensitive workflows — a national-security-adjacent angle.
- Technically rich enough (CV + NLP + systems + browser internals) to differentiate strong teams from copy-paste LLM-wrapper submissions.

---

## 4️⃣ Scope of Innovation — Existing Solutions 💡

### 🔍 Competitor / Existing Solution Landscape

| Solution | What it does | Privacy Model | Gap vs. this PS |
|---|---|---|---|
| **OpenAI Operator / ChatGPT Atlas agent** | Cloud VLM controls browser via screenshots | Screenshots sent fully to OpenAI servers | No local redaction at all |
| **Google Project Mariner** | Gemini-powered Chrome agent reading screen content | Cloud-processed, Google-side privacy controls | No client-side PII stripping before transmission |
| **Anthropic Claude Computer Use** | VLM-driven computer/browser control | Screenshots sent to Claude API | Same — server sees raw screen |
| **Nanobrowser** (open-source Chrome extension) | Local-first multi-agent browser automation, BYO-LLM-key | Keeps orchestration local, but still ships full page content/screenshots to whichever LLM API you configure | No visual PII detection/redaction layer; privacy = "your keys, your API," not true on-device sanitization |
| **Microsoft Copilot Vision / Edge Copilot** | Screen-aware assistant in Edge | Microsoft-hosted processing | No open, inspectable redaction pipeline |
| **Presidio / Philter / Kong AI Gateway PII filters** | Server-side text PII redaction (regex + NER) before LLM calls | Redaction happens at a gateway, not on the client, and works on **text**, not **screenshots** | This PS needs *visual* redaction (faces, form fields, ID cards) — a much harder, less-solved problem |
| **Research: SeeClick, CogAgent, Ferret-UI(-Lite), UI-TARS** | Academic/production GUI-grounding VLMs that click/act purely from screenshots | None of these papers address *privacy* — they optimize grounding accuracy only | This PS is genuinely novel in **combining GUI-grounding with mandatory client-side redaction** |

📎 Reference reading:
- SeeClick — GUI grounding via screenshots (arXiv:2401.10935)
- CogAgent — 18B VLM for GUI agents (CVPR 2024)
- Ferret-UI Lite — 3B on-device GUI agent, ScreenSpot benchmark
- Nanobrowser — github.com/nanobrowser/nanobrowser
- Microsoft Presidio — PII detection/anonymization engine (text-only, good reference for your NER layer)

### ❗ Limitations of existing solutions
- **Zero mainstream agent does real-time, on-device visual PII redaction** before any network call — this is the PS's real "white space."
- GUI-grounding research (SeeClick/CogAgent/Ferret-UI) optimizes for **accuracy**, not **privacy-latency-accuracy trade-offs together** — your team can genuinely cite a gap in the literature.
- Text-PII tools (Presidio, Philter) don't handle **pixels** — faces, screenshots of ID cards, or PII baked into images are invisible to them.

### 💡 Innovative angles you can add
- **Hybrid redaction**: combine (a) DOM-tag-based redaction for structured fields (`type="password"`, `autocomplete="cc-number"`) — cheap and precise — with (b) CV-based redaction (face/ID detection) for pixel-level leaks that DOM tags miss.
- **Confidence-tiered redaction**: don't binary redact — use a risk score per region, letting users see *why* something was blurred (explainability = strong evaluator differentiator).
- **On-device caching of UI "fingerprints"**: recognize previously-seen safe pages (e.g., google.com search bar) to skip redundant redaction compute → improves latency score.
- **Progressive disclosure protocol**: server never gets an unredacted image; if it needs more detail on a redacted region, it must explicitly request permission, and the *user* approves before any additional data is sent — a genuinely novel human-in-the-loop trust mechanic.
- **Standout tech add-ons**: WebAssembly SIMD for OCR speed-up; differential privacy noise injection on non-visual metadata sent to server; a small on-device "trust classifier" that flags entirely new/unknown UI patterns as high-risk by default.

---

## 5️⃣ Clarity of Problem Statement 🧩

### 📋 Clear deliverables
1. A **browser extension** (Chrome + Firefox) with a working local vision model (WebGPU-accelerated).
2. A **visible redaction demonstration** (blur/black-box/mask) shown live.
3. A **server component** that accepts *only* sanitized data and returns actionable UI commands.
4. An **end-to-end demo task** (e.g., filling a form, navigating a website) completed by the agent.

### ⚠️ Where teams misinterpret the PS
- **Treating this as "just build any browser AI agent."** The PS's actual grading weight (65% across accuracy/PII-recall/redaction-precision) shows the **privacy/redaction pipeline is the main deliverable**, not the agent's task-completion cleverness.
- **Doing only DOM-based redaction and skipping actual visual CV.** The PS explicitly says "local Vision Transformer (ViT) or equivalent computer vision model" — a pure DOM-scraping bot without any on-device vision model misses the core ask.
- **Sending full unredacted screenshots to server "for now" and promising redaction later.** This violates the privacy-by-design requirement even during a demo — evaluators will test exactly this.
- **Ignoring resource utilization** — teams often over-index on model accuracy and ignore that 20% of the score is literally about how light the client footprint is.

### 🧭 How to frame the solution for evaluators
- Open your pitch with **the privacy leak problem in current agentic browsers** (cite Operator/Mariner/Claude Computer Use sending raw screenshots) → then show your redaction-first architecture as the fix.
- Use a **live side-by-side demo**: raw screenshot vs. redacted payload actually transmitted (network tab open) — this single visual proves 3 of the 5 metrics instantly.
- Show a **metrics dashboard** (latency ms, CPU/GPU %, PII recall/precision on a test set you built) — mirrors the official rubric almost 1:1, making evaluation trivially easy and favorable for you.

---

## 6️⃣ Evaluator's Perspective 🎯

### ⚖️ Official weighted criteria (use this to allocate YOUR effort)
| Metric | Weight | What to optimize |
|---|---|---|
| Accuracy of visual context extraction | 25% | ViT/detector quality on UI element recognition |
| PII detection recall & precision | 20% | Balanced detector — don't over/under-flag |
| Precision of redaction | 20% | Tight bounding boxes, no leakage at edges, no over-blur of non-sensitive UI |
| Client-side resource utilization | 20% | Model size (use quantized ONNX, <50MB ideally), CPU/GPU/memory footprint |
| End-to-end latency | 15% | Total pipeline time per task-step |

**Key takeaway 🔑: Accuracy of *screen reading* + PII detection + redaction precision together are 65% of your score — this is fundamentally a computer-vision-and-privacy-engineering challenge wearing an "agent" costume.** Don't let the LLM/agent-orchestration part consume more than ~25% of your build time.

### 🚩 Red flags evaluators will notice
- No real client-side model running (faked with a server call disguised as local).
- Redaction that's cosmetic only (visually blurred in UI but the *actual bytes sent* still contain raw data — check the network payload, not just what's rendered).
- No handling of dynamic content (SPAs, canvas-rendered UI) — only works on static pages.
- Missing quantitative benchmarking — "it feels fast" isn't a metric; live latency/resource numbers are.
- Overreliance on a single closed commercial API for both local *and* server model (defeats "offline-deployable, open-source" spirit the PS asks for on the server side).

---

## 7️⃣ Strategy for Team Fit & Execution 👥

### 🧑‍💻 Skill sets needed
- **Computer Vision / ML engineer** — ONNX export/quantization, ViT/YOLO/face-detection models, OCR integration.
- **Browser/Extension developer (JS/TS)** — Manifest V3, content scripts, `chrome.tabCapture`/`debugger` APIs, WebGPU/WASM integration (Transformers.js, ONNX Runtime Web).
- **Backend/Systems engineer** — server-side VLM hosting (or API orchestration), redaction-aware protocol design, latency optimization.
- **NLP/PII specialist** — NER models, regex+ML hybrid for identifiers (Aadhaar-like numbers, cards, emails), inspired by Presidio-style pipelines.
- **UX/Product designer** — must visually communicate "what got redacted and why" — critical for evaluator trust and demo clarity.
- **Presentation/PM lead** — maps the demo directly onto the 5 scoring metrics, prepares the metrics dashboard.

### ⚖️ Ideal team ratio (6-member team assumption)
| Role | Count |
|---|---|
| CV/ML engineer | 2 |
| Browser extension/frontend dev | 1 |
| Backend/server + protocol dev | 1 |
| NLP/PII engineer | 1 |
| UX + presentation/PM | 1 |

### 🗺️ Step-by-step research → ideation → build approach
1. **Day 0 (research, 4–6 hrs)**: Study SeeClick/Ferret-UI-Lite for grounding approach; study Presidio/Philter for PII patterns; benchmark 2–3 ONNX-exportable small ViT/YOLO models for size/speed on WebGPU.
2. **Define your redaction taxonomy** early — decide exact PII classes you'll detect (faces, passwords, card numbers, Aadhaar-pattern numbers, emails, phone numbers) — this scopes both your CV and NER work.
3. **Build the capture→local-inference→redaction pipeline first** — this is 65% of your score; get a visually convincing demo of "before vs. after" ASAP, even before the agent/server loop works.
4. **Wire up the server VLM loop** using a free-tier or self-hosted open-weight model (Qwen2-VL/LLaVA) — keep it simple; a single "read this and tell me what to click" round trip is enough.
5. **Instrument everything**: latency timers per stage, resource usage logging (`performance.memory`, `navigator.hardwareConcurrency`) — build the metrics dashboard in parallel, not at the end.
6. **Test on 3 real-world page types**: a login form, a page with an embedded photo, and a government-style form with structured PII fields — covers DOM-based + CV-based redaction cases.
7. **Rehearse the demo around the rubric**, not around "cool agent tricks" — literally narrate each of the 5 metrics as you show it live.

---

## ✅ Key Takeaways (TL;DR)

- 🔑 **This PS is 65% a privacy-engineering/CV problem and 35% an agent-orchestration problem** — allocate your team's time accordingly.
- 🔑 **No existing browser agent (Operator, Mariner, Claude Computer Use, Nanobrowser) does true on-device visual PII redaction** — that's your unique wedge; say this explicitly to evaluators.
- 🔑 Build the **redaction demo first**, agent loop second — it's the fastest path to hitting 65% of the rubric.
- 🔑 Use **quantized ONNX models + WebGPU with WASM fallback** for real Chrome+Firefox compatibility.
- 🔑 **Instrument latency and resource usage from day one** — don't leave measurement to the final hours; it's 35% of your score combined.
- 🔑 Frame your pitch around the **real leak in today's agentic browsers**, backed by the competitor table above — a concrete, well-researched narrative beats a flashier but unfocused demo.
