// ============================================================
// SIH PRIVACY BROWSER AGENT
// perception.js
// ============================================================
//
// Stage 2 — Perception Foundation
//
// This module provides a common interface for all local
// perception sources.
//
// Current:
//   DOM  -> ACTIVE
//   OCR  -> REGISTERED / DISABLED
//   FACE -> REGISTERED / DISABLED
//
// Future:
//   Tesseract.js -> OCR
//   BlazeFace    -> FACE
//
// IMPORTANT PRIVACY RULE
// ----------------------
// All perception happens locally.
//
// Detector implementations may internally inspect sensitive
// values, but raw values must NEVER leave the content script.
//
// Only sanitized detection metadata should be passed to the
// screenshot redaction / backend pipeline.
// ============================================================

(function () {

    "use strict";


    // ========================================================
    // PERCEPTION VERSION
    // ========================================================

    const VERSION = "2.0.0";


    // ========================================================
    // DETECTOR REGISTRY
    // ========================================================

    const detectors = new Map();


    // ========================================================
    // REGISTER DETECTOR
    // ========================================================

    function registerDetector(name, config) {

        if (!name || typeof name !== "string") {
            throw new Error("Perception detector name is required.");
        }

        if (!config || typeof config.detect !== "function") {
            throw new Error(`Detector "${name}" must provide a detect() function.`);
        }

        detectors.set(name, {
            name,
            enabled: config.enabled !== false,
            source: config.source || name,
            detect: config.detect,
            version: config.version || "1.0.0"
        });

        console.log("[PERCEPTION] Detector registered:", name);
    }


    // ========================================================
    // ENABLE / DISABLE
    // ========================================================

    function setDetectorEnabled(name, enabled) {

        const detector = detectors.get(name);

        if (!detector) {
            console.warn("[PERCEPTION] Unknown detector:", name);
            return false;
        }

        detector.enabled = Boolean(enabled);

        console.log("[PERCEPTION]", name, detector.enabled ? "ENABLED" : "DISABLED");

        return true;
    }


    // ========================================================
    // DETECTOR STATUS
    // ========================================================

    function getDetectorStatus() {

        return Array.from(detectors.values()).map(detector => ({
            name: detector.name,
            source: detector.source,
            enabled: detector.enabled,
            version: detector.version
        }));
    }


    // ========================================================
    // SAFE DETECTION NORMALIZATION
    // ========================================================
    //
    // Every detector eventually produces the same shape:
    //
    // {
    //     type: "PAN",
    //     source: "dom",
    //     confidence: 0.98,
    //     rect: {
    //         left,
    //         top,
    //         right,
    //         bottom,
    //         width,
    //         height
    //     }
    // }
    //
    // Raw PII values are intentionally NOT included.
    // ========================================================

    function normalizeDetection(detection, detector) {

        if (!detection || typeof detection !== "object") {
            return null;
        }

        const rect = detection.rect;

        if (
            !rect ||
            !Number.isFinite(Number(rect.left)) ||
            !Number.isFinite(Number(rect.top)) ||
            !Number.isFinite(Number(rect.right)) ||
            !Number.isFinite(Number(rect.bottom))
        ) {
            return null;
        }

        const width = Number.isFinite(Number(rect.width))
            ? Number(rect.width)
            : Math.max(0, Number(rect.right) - Number(rect.left));

        const height = Number.isFinite(Number(rect.height))
            ? Number(rect.height)
            : Math.max(0, Number(rect.bottom) - Number(rect.top));

        let confidence = Number(detection.confidence);

        if (!Number.isFinite(confidence)) {
            confidence = 1;
        }

        confidence = Math.min(1, Math.max(0, confidence));

        return {
            type: String(detection.type || "UNKNOWN").toUpperCase(),
            source: String(detection.source || detector.source).toLowerCase(),
            confidence,
            rect: {
                left: Number(rect.left),
                top: Number(rect.top),
                right: Number(rect.right),
                bottom: Number(rect.bottom),
                width,
                height
            }
        };
    }


    // ========================================================
    // RUN DETECTORS (ASYNC)
    // ========================================================
    //
    // The manager does NOT itself inspect webpage content.
    //
    // It simply orchestrates registered local detectors.
    //
    // Phase 1:
    //     DOM detector is supplied by content.js.
    //
    // Phase 2:
    //     OCR detector will be registered here.
    //
    // Phase 3:
    //     Face detector will be registered here.
    // ========================================================

    async function run(context = {}) {

        const start = performance.now();
        const results = [];

        for (const detector of detectors.values()) {

            if (!detector.enabled) {
                continue;
            }

            try {

                const detectorResult = await detector.detect(context);

                if (!Array.isArray(detectorResult)) {
                    continue;
                }

                for (const detection of detectorResult) {

                    const normalized = normalizeDetection(detection, detector);

                    if (normalized) {
                        results.push(normalized);
                    }
                }

            } catch (error) {
                console.error("[PERCEPTION] Detector failed:", detector.name, error?.message || error);
            }
        }

        const latency = performance.now() - start;

        console.log(
            "[PERCEPTION] Cycle completed:",
            `${latency.toFixed(2)} ms`,
            `| detections=${results.length}`
        );

        return {
            detections: results,
            latencyMs: latency,
            detectors: getDetectorStatus()
        };
    }


    // ========================================================
    // SYNCHRONOUS RUN
    // ========================================================
    //
    // Phase 1 DOM detector is synchronous.
    //
    // This method keeps the current privacy engine synchronous.
    //
    // When OCR/Face are added, we will introduce an explicit
    // asynchronous perception cycle without breaking capture.
    // ========================================================

    function runSync(context = {}) {

        const start = performance.now();
        const results = [];

        for (const detector of detectors.values()) {

            if (!detector.enabled) {
                continue;
            }

            try {

                const detectorResult = detector.detect(context);

                if (!Array.isArray(detectorResult)) {
                    continue;
                }

                for (const detection of detectorResult) {

                    const normalized = normalizeDetection(detection, detector);

                    if (normalized) {
                        results.push(normalized);
                    }
                }

            } catch (error) {
                console.error("[PERCEPTION] Detector failed:", detector.name, error?.message || error);
            }
        }

        const latency = performance.now() - start;

        console.log(
            "[PERCEPTION] Sync cycle:",
            `${latency.toFixed(2)} ms`,
            `| detections=${results.length}`
        );

        return {
            detections: results,
            latencyMs: latency,
            detectors: getDetectorStatus()
        };
    }


    // ========================================================
    // SAFE SERIALIZATION
    // ========================================================
    //
    // This is deliberately separate from the internal
    // detector representation.
    //
    // No "value", "text", "rawValue", etc. are allowed.
    // ========================================================

    function serializeDetections(detectionList) {

        if (!Array.isArray(detectionList)) {
            return [];
        }

        return detectionList.map(detection => ({
            type: detection.type,
            source: detection.source,
            confidence: Number(detection.confidence),
            rect: detection.rect
                ? {
                    left: Number(detection.rect.left),
                    top: Number(detection.rect.top),
                    right: Number(detection.rect.right),
                    bottom: Number(detection.rect.bottom),
                    width: Number(detection.rect.width),
                    height: Number(detection.rect.height)
                }
                : null
        }));
    }


    // ========================================================
    // FUTURE DETECTOR SLOTS
    // ========================================================
    //
    // These are intentionally disabled in Phase 1.
    //
    // Phase 2:
    //     Tesseract.js will replace the OCR placeholder.
    //
    // Phase 3:
    //     Face detector will replace the face placeholder.
    //
    // Registered here, inside the closure, BEFORE the public
    // API is exposed, so `registerDetector` is in scope.
    // ========================================================

    registerDetector("ocr", {
        enabled: false,
        source: "ocr",
        version: "0.0.0",
        detect: function () {
            return [];
        }
    });

    registerDetector("face", {
    enabled: false,
    source: "vision",
    version: window.SIHFace?.version || "3.1.0",

    detect: async function (context = {}) {

        if (
            !window.SIHFace ||
            typeof window.SIHFace.detect !== "function"
        ) {
            console.warn(
                "[PERCEPTION] SIHFace is not available."
            );

            return [];
        }

        try {

            return await window.SIHFace.detect(context);

        } catch (error) {

            console.error(
                "[PERCEPTION] Face detector failed:",
                error?.message || error
            );

            return [];
        }
    }
});


    // ========================================================
    // PUBLIC API
    // ========================================================

    window.SIHPerception = {
        version: VERSION,
        registerDetector,
        setDetectorEnabled,
        getDetectorStatus,
        run,
        runSync,
        normalizeDetection,
        serializeDetections
    };


    // ========================================================
    // INITIAL STATUS
    // ========================================================

    console.log("[PERCEPTION] Foundation loaded:", VERSION);

})();