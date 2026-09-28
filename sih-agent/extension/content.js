// ============================================================
// SIH PRIVACY BROWSER AGENT
// content.js
// ============================================================
//
// Privacy-first browser agent content script.
//
// IMPORTANT PRIVACY RULE
// ----------------------
// The webpage itself is NEVER visually masked by this script.
//
// PII masking is applied ONLY to screenshots captured by the
// extension, immediately before those screenshots are allowed
// to leave the browser.
//
// The content script:
//   1. Detects PII locally.
//   2. Provides safe DOM metadata.
//   3. Sanitizes screenshots locally.
//   4. Executes approved browser actions.
//   5. Supports scrolling + re-perception.
//
// ============================================================

console.log("SIH Privacy Agent loaded");


// ============================================================
// CONFIGURATION
// ============================================================

const SIH_CONFIG = {

    overlayColor: "#000000",

    overlayZIndex: 2147483647,

    maxDOMElements: 100,

    mutationDelay: 250,

    inputDelay: 150,

    scrollAmount: 600,

    scrollDuration: 400,

    // Browser-agent safety limits.
    maxScrollAmount: 1500,

    minWaitMs: 100,

    maxWaitMs: 5000,

    // Maximum coordinate tolerance for browser viewport.
    coordinateTolerance: 1,

    // Sanitized screenshot transmission format.
    // Set transmitWebP to false to always send PNG
    // (WebP is still measured for the benchmark).
    transmitWebP: true,
    webpQuality: 0.82
};


// ============================================================
// PII PATTERNS
// ============================================================

const PII_PATTERNS = {

    EMAIL:
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,

    PHONE:
        /(?<![\d])(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)/g,

    /*
     * Aadhaar must NOT be part of a larger number.
     *
     * This prevents:
     *
     * 4111 1111 1111 1111
     *
     * from being partially detected as Aadhaar.
     */

    AADHAAR:
        /(?<![+\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\d\s-])/g,

    PAN:
    /\b[A-Z]{5}\d{4}[A-Z]\b/gi,

    CREDIT_CARD:
        /\b(?:\d[ -]?){13,19}\b/g
};

// ============================================================
// BENCHMARK METRICS
// ============================================================

// Extra margin (CSS px) painted around every detected PII region.
// Covers anti-aliasing / sub-pixel scaling at the region edges.
const REDACTION_PADDING = 3;

const FACE_CONFIDENCE_THRESHOLD = 0.60;

const FACE_DETECTION_TIMEOUT_MS = 10000;
const SCREENSHOT_PIPELINE_TIMEOUT_MS = 30000;

function createEmptyBenchmarkMetrics() {
    return {
        piiDetectionLatencyMs: 0,
        domPerceptionLatencyMs: 0,
        redactionLatencyMs: 0,
        verificationLatencyMs: 0,
        actionExecutionLatencyMs: 0,

        screenshotBeforeBytes: 0,

        // Sanitized PNG benchmark
        screenshotPngBytes: 0,

        // Sanitized WebP benchmark
        screenshotWebpBytes: 0,

        // Final image actually selected for transmission
        screenshotAfterBytes: 0,
        screenshotFormat: "",

        // Compression benchmark
        // (compressionLatencyMs = PNG encode + WebP encode; both
        //  run while benchmarking, so the individual encode times
        //  are kept as well)
        compressionLatencyMs: 0,
        pngEncodeLatencyMs: 0,
        webpEncodeLatencyMs: 0,
        compressionRatio: 0,   // selected bytes / raw screenshot bytes

        detectionCount: 0,

// ========================================================
// PHASE 3 â€” FACE DETECTION METRICS
// ========================================================

faceDetectionLatencyMs: 0,
faceDetectionCount: 0,
faceDetectionFailed: false,
faceDetectionAvailable: false,

faceDetectionsBeforeFilter: 0,
faceDetectionsRejected: 0,
faceAverageConfidence: 0,

fusionLatencyMs: 0,
fusionInputRegions: 0,
fusionOutputRegions: 0,

domDetectionCount: 0,
ocrDetectionCount: 0,

screenshotPipelineLatencyMs: 0,

// ========================================================
// PHASE 2.5 â€” ADVANCED REDACTION METRICS
// ========================================================

unifiedPIIRegions: 0,
inCaptureRegions: 0,
outOfViewRegions: 0,
invalidRegions: 0,
redactedRegions: 0,

verificationRegions: 0,
verificationFailedRegions: 0,
verificationPassed: null,

// Fail-closed privacy gate.
// true  = sanitized screenshot may be transmitted.
// false = transmission must be blocked.
privacyGatePassed: null
    };
}

let benchmarkMetrics = createEmptyBenchmarkMetrics();

function resetBenchmarkMetrics() {
    benchmarkMetrics = createEmptyBenchmarkMetrics();
}

function isValidDetectionRect(rect) {
    if (!rect) {
        return false;
    }

    const values = [
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        rect.width,
        rect.height
    ].map(Number);

    if (!values.every(Number.isFinite)) {
        return false;
    }

    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        return false;
    }

    if (
        rect.right <= rect.left ||
        rect.bottom <= rect.top
    ) {
        return false;
    }

    return true;
}


function normalizeFaceDetections(faceResult) {

    const source =
        Array.isArray(faceResult)
            ? faceResult
            : Array.isArray(faceResult?.detections)
                ? faceResult.detections
                : [];

    return source
        .map(function (detection) {

            if (!detection || !detection.rect) {
                return null;
            }

            const rawRect = detection.rect;

            /*
             * face.js returns:
             *
             * {
             *     x,
             *     y,
             *     width,
             *     height
             * }
             *
             * Convert it to the content.js rectangle format:
             *
             * {
             *     left,
             *     top,
             *     right,
             *     bottom,
             *     width,
             *     height
             * }
             */

            const left = Number.isFinite(Number(rawRect.left))
                ? Number(rawRect.left)
                : Number(rawRect.x);

            const top = Number.isFinite(Number(rawRect.top))
                ? Number(rawRect.top)
                : Number(rawRect.y);

            const width = Number(rawRect.width);
            const height = Number(rawRect.height);

            if (
                !Number.isFinite(left) ||
                !Number.isFinite(top) ||
                !Number.isFinite(width) ||
                !Number.isFinite(height) ||
                width <= 0 ||
                height <= 0
            ) {
                return null;
            }

            const right =
                Number.isFinite(Number(rawRect.right))
                    ? Number(rawRect.right)
                    : left + width;

            const bottom =
                Number.isFinite(Number(rawRect.bottom))
                    ? Number(rawRect.bottom)
                    : top + height;

            const rect = {
                left,
                top,
                right,
                bottom,
                width,
                height
            };

            if (!isValidDetectionRect(rect)) {
                return null;
            }

            const confidence =
                Number(detection.confidence);

            if (
                !Number.isFinite(confidence) ||
                confidence < FACE_CONFIDENCE_THRESHOLD ||
                confidence > 1
            ) {
                return null;
            }

            return {
                type: "FACE",

                source: "vision",

                confidence,

                rect
            };
        })
        .filter(Boolean);
}


function logPrivacyPipelineSummary() {

    console.log(
        "[PRIVACY] Pipeline summary:",
        {
            dom:
                benchmarkMetrics.domDetectionCount || 0,

            ocr:
                benchmarkMetrics.ocrDetectionCount || 0,

            face:
                benchmarkMetrics.faceDetectionCount || 0,

            faceConfidence:
                benchmarkMetrics.faceAverageConfidence || 0,

            faceRejected:
                benchmarkMetrics.faceDetectionsRejected || 0,

            faceLatency:
                benchmarkMetrics.faceDetectionLatencyMs || 0,

            fused:
                benchmarkMetrics.fusionOutputRegions || 0,

            redacted:
                benchmarkMetrics.redactedRegions || 0,

            verified:
                benchmarkMetrics.verificationPassed === true,

            privacyGate:
                benchmarkMetrics.privacyGatePassed === true
        }
    );
}

function getDataUrlByteSize(dataUrl) {
    if (!dataUrl) {
        return 0;
    }

    const commaIndex = dataUrl.indexOf(",");

    if (commaIndex === -1) {
        return 0;
    }

    const base64 = dataUrl.slice(
        commaIndex + 1
    );

    return Math.floor(
        base64.length * 3 / 4
    );
}

// ============================================================
// IMAGE COMPRESSION BENCHMARK
// ============================================================
//
// Creates a WebP representation of the already-sanitized
// canvas.
//
// IMPORTANT:
// This function is called ONLY after redaction verification
// has passed.
//
// The raw screenshot is never encoded here.
//
// canvas.toDataURL() silently falls back to PNG when a format is
// unsupported, so the MIME type of the result is checked.
// ============================================================

function encodeSanitizedWebP(canvas) {

    const compressionStart =
        performance.now();

    let webpDataUrl = "";

    try {

        webpDataUrl =
            canvas.toDataURL(
                "image/webp",
                SIH_CONFIG.webpQuality
            );

    } catch (error) {

        console.warn(
            "[BENCHMARK] WebP encoding failed:",
            error
        );

        return {
            dataUrl: "",
            bytes: 0,
            latencyMs:
                performance.now() -
                compressionStart
        };
    }

    const latencyMs =
        performance.now() -
        compressionStart;

    if (
        !String(webpDataUrl).startsWith(
            "data:image/webp"
        )
    ) {

        console.warn(
            "[BENCHMARK] WebP not supported, PNG will be used"
        );

        return {
            dataUrl: "",
            bytes: 0,
            latencyMs
        };
    }

    return {
        dataUrl: webpDataUrl,
        bytes:
            getDataUrlByteSize(
                webpDataUrl
            ),
        latencyMs
    };
}

// JS heap of this content-script context (Chrome only).
// NOT total system RAM.
function getJsHeapMetrics() {

    const memory =
        performance.memory;

    if (!memory) {
        return null;
    }

    return {
        usedMB:
            memory.usedJSHeapSize /
            1024 /
            1024,

        totalMB:
            memory.totalJSHeapSize /
            1024 /
            1024
    };
}

// Only numbers / booleans - no PII can appear here.
function getBenchmarkSnapshot() {

    const m =
        benchmarkMetrics;

    // Encode cost of the format that was actually selected
    // (both encoders run while benchmarking; only one would
    // be needed in production).
    const selectedEncodeMs =
        m.screenshotFormat === "image/webp"
            ? m.webpEncodeLatencyMs
            : m.pngEncodeLatencyMs;

    return {
        ...m,

        // Sum of the most recent local privacy-engine measurements.
        totalLocalPrivacyMs:
            m.piiDetectionLatencyMs +
            m.domPerceptionLatencyMs +
            m.redactionLatencyMs +
            m.verificationLatencyMs +
            selectedEncodeMs,

        jsHeap:
            getJsHeapMetrics()
    };
}
// ============================================================
// STATE
// ============================================================

let detections = [];

let privacyOverlays = [];

let privacyEngineRunning = false;

let captureInProgress = false;

let captureGeneration = 0;

// Separate from captureInProgress: an OCR benchmark run must
// never contaminate or block the production capture pipeline,
// and vice versa.
let ocrBenchmarkInProgress = false;

let lastDetectionSignature = "";


// ============================================================
// UTILITY
// ============================================================

function normalizeText(text) {

    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

function isValidPANCandidate(value) {

    const pan =
        String(value || "")
            .trim()
            .toUpperCase();

    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) {
        return false;
    }

    /*
     * PAN structure:
     *
     * Characters 1â€“3: alphabetic
     * Character 4: holder category
     * Character 5: surname/name initial
     * Characters 6â€“9: numeric
     * Character 10: alphabetic
     *
     * Common holder categories:
     *
     * P = Individual
     * C = Company
     * H = HUF
     * F = Firm / LLP
     * A = Association of Persons
     * T = Trust
     * B = Body of Individuals
     * L = Local Authority
     * J = Artificial Juridical Person
     * G = Government
     */

    const holderCategory =
        pan.charAt(3);

    const validCategories =
        new Set([
            "P",
            "C",
            "H",
            "F",
            "A",
            "T",
            "B",
            "L",
            "J",
            "G"
        ]);

    if (!validCategories.has(holderCategory)) {
        return false;
    }

    return true;
}
// ============================================================
// VISIBILITY
// ============================================================

function isVisible(element) {

    if (!element) {
        return false;
    }

    const style =
        window.getComputedStyle(element);

    if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
    ) {
        return false;
    }

    const rect =
        element.getBoundingClientRect();

    return (
        rect.width > 0 &&
        rect.height > 0
    );
}


// ============================================================
// VIEWPORT CHECK
// ============================================================
//
// IMPORTANT:
//
// An element can be:
//   - visible in the document
//   - but outside the current viewport.
//
// Previously those elements were discarded from safe DOM.
//
// Now they remain available to the planner with:
//   in_viewport: true / false
//
// This allows the planner to recognize an off-screen Submit
// button and return a SCROLL action.
// ============================================================

function isInViewport(rect) {

    if (!rect) {
        return false;
    }

    return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
    );
}


// ============================================================
// DOCUMENT POSITION
// ============================================================

function getDocumentCoordinates(rect) {

    if (!rect) {
        return {
            x: 0,
            y: 0
        };
    }

    return {

        x:
            Math.round(
                rect.left +
                window.scrollX
            ),

        y:
            Math.round(
                rect.top +
                window.scrollY
            )
    };
}


// ============================================================
// NUMERIC VALUE
// ============================================================

function getNumericValue(value) {

    return String(value || "")
        .replace(/\D/g, "");
}


// ============================================================
// LUHN CHECK
// ============================================================

function luhnCheck(number) {

    const digits =
        getNumericValue(number);

    if (
        digits.length < 13 ||
        digits.length > 19
    ) {
        return false;
    }

    let sum = 0;

    let alternate = false;

    for (
        let i = digits.length - 1;
        i >= 0;
        i--
    ) {

        let n =
            Number(
                digits[i]
            );

        if (alternate) {

            n *= 2;

            if (n > 9) {
                n -= 9;
            }
        }

        sum += n;

        alternate =
            !alternate;
    }

    return (
        sum % 10 === 0
    );
}


// ============================================================
// AADHAAR VALIDATION
// ============================================================

function isAadhaarCandidate(
    text,
    match,
    matchIndex
) {

    const digits =
        getNumericValue(match);

    /*
     * Aadhaar must contain exactly 12 digits.
     */

    if (
        digits.length !== 12
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * CHECK BEFORE MATCH
     * --------------------------------------------------------
     *
     * Reject if the match is immediately preceded by:
     *
     * +91
     * another digit
     * digit separator belonging to a larger number
     */

    const before =
        text.slice(
            Math.max(
                0,
                matchIndex - 5
            ),
            matchIndex
        );

    if (
        /\d[\s-]*$/.test(
            before
        )
    ) {
        return false;
    }

    if (
        /\+91[\s-]*$/i.test(
            before
        )
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * CHECK AFTER MATCH
     * --------------------------------------------------------
     */

    const afterStart =
        matchIndex +
        match.length;

    const after =
        text.slice(
            afterStart,
            afterStart + 6
        );

    if (
        /^\s*[\d]/.test(
            after
        )
    ) {
        return false;
    }

    if (
        /^\s*[- ]\s*\d/.test(
            after
        )
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * FULL TOKEN CHECK
     * --------------------------------------------------------
     */

    const tokenBefore =
        text.slice(
            Math.max(
                0,
                matchIndex - 20
            ),
            matchIndex
        );

    const tokenAfter =
        text.slice(
            afterStart,
            Math.min(
                text.length,
                afterStart + 20
            )
        );

    const surrounding =
        `${tokenBefore}${match}${tokenAfter}`;

    const surroundingDigits =
        getNumericValue(
            surrounding
        );

    /*
     * If the surrounding area is clearly a long
     * payment-card-like sequence, reject Aadhaar.
     */

    if (
        surroundingDigits.length > 12
    ) {
        return false;
    }

    return true;
}


// ============================================================
// DETECTION DUPLICATE CHECK
// ============================================================

function detectionAlreadyExists(
    type,
    value,
    rect
) {

    return detections.some(
        existing => {

            if (
                existing.type !== type
            ) {
                return false;
            }

            // Without geometry we can only compare values.
            if (
                !existing.rect ||
                !rect
            ) {
                return existing.value === value;
            }

            /*
             * Same value at a DIFFERENT position is a different
             * on-screen occurrence and must be redacted too.
             * Only a genuinely overlapping rectangle is a duplicate.
             */

            const a =
                existing.rect;

            const b =
                rect;

            const overlap =
                !(
                    a.right <= b.left ||
                    a.left >= b.right ||
                    a.bottom <= b.top ||
                    a.top >= b.bottom
                );

            return overlap;
        }
    );
}


// ============================================================
// ADD DETECTION
// ============================================================

function addDetection(
    type,
    value,
    element,
    rect,
    source = "dom"
) {

    if (!value) {
        return;
    }

    const cleanValue =
        String(value);

    if (
        detectionAlreadyExists(
            type,
            cleanValue,
            rect
        )
    ) {
        return;
    }

    detections.push({

        id:
            `${type}-${detections.length + 1}`,

        type,

        value:
            cleanValue,

        source,

        tagName:
            element
                ? element.tagName
                : "",

        rect:
            rect
                ? {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height
                }
                : null
    });
}


// ============================================================
// TIGHT MATCH RECTANGLES
// ============================================================
//
// Instead of redacting the whole parent element (e.g. an entire
// paragraph), compute the rectangle of just the matched
// characters using a DOM Range on the text node.
//
// PII regexes run on whitespace-normalized text, so we keep a
// map from normalized index -> raw text-node offset.
//
// If anything looks inconsistent, we return null and the caller
// falls back to the (larger, safer) parent element rectangle.
// ============================================================

function buildNormalizedOffsetMap(raw) {

    let normalized = "";

    const map = [];

    let pendingSpaceAt = -1;

    for (let i = 0; i < raw.length; i++) {

        const ch = raw[i];

        if (/\s/.test(ch)) {

            if (
                normalized.length > 0 &&
                pendingSpaceAt === -1
            ) {
                pendingSpaceAt = i;
            }

            continue;
        }

        if (pendingSpaceAt !== -1) {

            normalized += " ";
            map.push(pendingSpaceAt);
            pendingSpaceAt = -1;
        }

        normalized += ch;
        map.push(i);
    }

    return { normalized, map };
}

function createTextRangeRectResolver(
    textNode,
    normalizedText
) {

    const raw =
        textNode.textContent || "";

    const { normalized, map } =
        buildNormalizedOffsetMap(raw);

    if (
        normalized !== normalizedText ||
        map.length !== normalizedText.length
    ) {
        return null;
    }

    return function resolve(start, end) {

        try {

            if (
                start < 0 ||
                end > map.length ||
                end <= start
            ) {
                return null;
            }

            const range =
                document.createRange();

            range.setStart(
                textNode,
                map[start]
            );

            range.setEnd(
                textNode,
                map[end - 1] + 1
            );

            const rects =
                Array.from(
                    range.getClientRects()
                ).filter(
                    r =>
                        r.width > 0 &&
                        r.height > 0
                );

            if (rects.length === 0) {
                return null;
            }

            // A match wrapped over several lines becomes the
            // bounding box of all its line fragments
            // (may over-redact, never under-redacts).
            const left =
                Math.min(...rects.map(r => r.left));

            const top =
                Math.min(...rects.map(r => r.top));

            const right =
                Math.max(...rects.map(r => r.right));

            const bottom =
                Math.max(...rects.map(r => r.bottom));

            return {
                left,
                top,
                right,
                bottom,
                width: right - left,
                height: bottom - top
            };

        } catch (_) {

            return null;
        }
    };
}


// ============================================================
// REGEX PII DETECTION
// ============================================================

function detectPIIPatterns(
    text,
    element,
    rect,
    source = "text",
    rectResolver = null
) {

    if (!text) {
        return;
    }

    const input =
        String(text);

    let match;

    // Tight rectangle for a match, or the element rectangle
    // when no resolver is available / it fails.
    const rectFor =
        (start, length) => {

            if (!rectResolver) {
                return rect;
            }

            return (
                rectResolver(
                    start,
                    start + length
                ) || rect
            );
        };


    // ========================================================
    // EMAIL
    // ========================================================

    PII_PATTERNS.EMAIL.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.EMAIL.exec(
                    input
                )
        ) !== null
    ) {

        addDetection(
            "EMAIL",
            match[0],
            element,
            rectFor(match.index, match[0].length),
            source
        );
    }


    // ========================================================
    // PHONE
    // ========================================================

    PII_PATTERNS.PHONE.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.PHONE.exec(
                    input
                )
        ) !== null
    ) {

        addDetection(
            "PHONE",
            match[0],
            element,
            rectFor(match.index, match[0].length),
            source
        );
    }


    // ========================================================
    // AADHAAR
    // ========================================================

    PII_PATTERNS.AADHAAR.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.AADHAAR.exec(
                    input
                )
        ) !== null
    ) {

        const valid =
            isAadhaarCandidate(
                input,
                match[0],
                match.index
            );

        if (valid) {

            addDetection(
                "AADHAAR",
                match[0],
                element,
                rectFor(match.index, match[0].length),
                source
            );
        }
    }


    // ========================================================
    // PAN
    // ========================================================

    PII_PATTERNS.PAN.lastIndex = 0;

    while (
    (
        match =
            PII_PATTERNS.PAN.exec(
                input
            )
    ) !== null
) {

    if (
        isValidPANCandidate(
            match[0]
        )
    ) {

        addDetection(
    "PAN",
    match[0],
    element,
    rectFor(match.index, match[0].length),
    source
);
    }
}


    // ========================================================
    // CREDIT CARD
    // ========================================================

    PII_PATTERNS.CREDIT_CARD.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.CREDIT_CARD.exec(
                    input
                )
        ) !== null
    ) {

        if (
            luhnCheck(
                match[0]
            )
        ) {

            addDetection(
                "CREDIT_CARD",
                match[0],
                element,
                rectFor(match.index, match[0].length),
                source
            );
        }
    }
}


// ============================================================
// PASSWORD DETECTION
// ============================================================

function detectPasswordField(
    element
) {

    if (
        !element ||
        element.tagName !== "INPUT"
    ) {
        return;
    }

    if (
        (
            element.type ||
            ""
        ).toLowerCase() !== "password"
    ) {
        return;
    }

    const rect =
        element.getBoundingClientRect();

    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        return;
    }

    addDetection(
        "PASSWORD",
        "[REDACTED_PASSWORD]",
        element,
        rect,
        "input"
    );
}


// ============================================================
// DOM PII ENGINE
// ============================================================

function detectDOMPII() {

    const benchmarkStart =
        performance.now();

    resetDetections();


    // ========================================================
    // BODY CHECK
    // ========================================================

    if (!document.body) {
        return;
    }


    // ========================================================
    // TEXT NODES
    // ========================================================

    const walker =
        document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT
        );

    const textNodes = [];

    let node;

    while (
        (
            node =
                walker.nextNode()
        )
    ) {

        textNodes.push(
            node
        );
    }


    for (
        const textNode of textNodes
    ) {

        const parent =
            textNode.parentElement;

        if (
            !parent ||
            !isVisible(parent)
        ) {
            continue;
        }

        if (
            parent.closest(
                "[data-sih-privacy-overlay='true']"
            )
        ) {
            continue;
        }

        const text =
            normalizeText(
                textNode.textContent
            );

        if (!text) {
            continue;
        }

        const rect =
            parent.getBoundingClientRect();

        const rectResolver =
            createTextRangeRectResolver(
                textNode,
                text
            );

        detectPIIPatterns(
            text,
            parent,
            rect,
            "text",
            rectResolver
        );
    }


    // ========================================================
    // INPUT / TEXTAREA VALUES
    // ========================================================

    const fields =
        document.querySelectorAll(
            "input, textarea"
        );

    fields.forEach(
        field => {

            if (
                !isVisible(field)
            ) {
                return;
            }


            // Password
            detectPasswordField(
                field
            );


            const rect =
                field.getBoundingClientRect();

            const value =
                field.value || "";

            /*
             * Value is processed ONLY locally.
             *
             * It is NOT added to safe DOM metadata.
             */

            if (value) {

                detectPIIPatterns(
                    value,
                    field,
                    rect,
                    "input-value"
                );
            }
        }
    );


    benchmarkMetrics.piiDetectionLatencyMs =
        performance.now() -
        benchmarkStart;

    benchmarkMetrics.detectionCount =
        detections.length;

    console.log(
        "[BENCHMARK] PII detection latency:",
        benchmarkMetrics.piiDetectionLatencyMs.toFixed(2),
        "ms"
    );

    console.log(
    "[PRIVACY] Local PII detection completed:",
    detections.length,
    "regions"
);
}


// ============================================================
// RESET DETECTIONS
// ============================================================

function resetDetections() {

    detections = [];
}
// ============================================================
// STAGE 2 â€” DOM PERCEPTION ADAPTER
// ============================================================
//
// The existing DOM PII engine remains unchanged.
//
// This adapter exposes its results through the new
// Perception Foundation interface.
//
// IMPORTANT:
// Raw detection.value remains LOCAL ONLY.
// ============================================================

function runDOMPerceptionAdapter() {

    detectDOMPII();

    return detections.map(
        detection => ({

            type:
                detection.type,

            source:
                "dom",

            confidence:
                1,

            rect:
                detection.rect
                    ? {
                        left:
                            detection.rect.left,

                        top:
                            detection.rect.top,

                        right:
                            detection.rect.right,

                        bottom:
                            detection.rect.bottom,

                        width:
                            detection.rect.width,

                        height:
                            detection.rect.height
                    }
                    : null
        })
    );
}


if (
    window.SIHPerception &&
    typeof window.SIHPerception.registerDetector ===
        "function"
) {

    window.SIHPerception.registerDetector(
        "dom",
        {
            enabled: true,
            source: "dom",
            version: "1.0.0",
            detect:
                runDOMPerceptionAdapter
        }
    );

} else {

    console.error(
        "[PERCEPTION] Perception manager not loaded."
    );
}

// ============================================================
// SERIALIZABLE DETECTIONS
// ============================================================
//
// SECURITY RULE:
//
// Detection values are LOCAL-ONLY.
//
// The actual PII value is required internally for detection,
// but it must NEVER be serialized into a message sent outside
// the content script.
//
// The server only needs:
// - detection type
// - source
// - element type
// - redaction rectangle
//
// It does NOT need the detected value.
//

function getSerializableDetections() {

    return detections.map(
        detection => ({

            id:
                detection.id,

            type:
                detection.type,

            source:
                detection.source,

            tagName:
                detection.tagName,

            rect:
                detection.rect
                    ? {
                        left:
                            Number(
                                detection.rect.left
                            ),

                        top:
                            Number(
                                detection.rect.top
                            ),

                        right:
                            Number(
                                detection.rect.right
                            ),

                        bottom:
                            Number(
                                detection.rect.bottom
                            ),

                        width:
                            Number(
                                detection.rect.width
                            ),

                        height:
                            Number(
                                detection.rect.height
                            )
                    }
                    : null
        })
    );
}


// ============================================================
// SAFE DOM EXTRACTION
// ============================================================
//
// IMPORTANT CHANGE:
//
// Previously:
//   elements outside the viewport were discarded.
//
// Now:
//   off-screen elements are retained.
//
// The planner receives:
//
//   in_viewport: true
//   in_viewport: false
//
// This allows the backend to recognize that a target exists
// below the current viewport and request a scroll.
//
// We still NEVER send input.value.
// ============================================================

function collectSafeDOM() {

    const start =
        performance.now();

    const result =
        collectSafeDOMUntimed();

    benchmarkMetrics.domPerceptionLatencyMs =
        performance.now() -
        start;

    console.log(
        "[BENCHMARK] DOM perception latency:",
        benchmarkMetrics.domPerceptionLatencyMs.toFixed(2),
        "ms"
    );

    return result;
}

function collectSafeDOMUntimed() {

    const elements = [];

    const candidates =
        document.querySelectorAll(
            [
                "button",
                "input",
                "textarea",
                "select",
                "a",
                "label",
                "[role='button']",
                "[role='link']",
                "[aria-label]"
            ].join(",")
        );


    const collected = [];


    candidates.forEach(
        (element, index) => {

            if (
                collected.length >=
                SIH_CONFIG.maxDOMElements
            ) {
                return;
            }

            if (
                !isVisible(element)
            ) {
                return;
            }

            if (
                element.closest(
                    "[data-sih-privacy-overlay='true']"
                )
            ) {
                return;
            }


            const rect =
                element.getBoundingClientRect();

            const inViewport =
                isInViewport(
                    rect
                );


            const tag =
                element.tagName.toLowerCase();

            const type =
                element.getAttribute(
                    "type"
                ) || "";

            const role =
                element.getAttribute(
                    "role"
                ) || "";

            const ariaLabel =
                element.getAttribute(
                    "aria-label"
                ) || "";

            const name =
                element.getAttribute(
                    "name"
                ) || "";

            const placeholder =
                element.getAttribute(
                    "placeholder"
                ) || "";


            // =================================================
            // BUTTON-LIKE IDENTIFICATION
            // =================================================

            const isButtonLike =
                tag === "button" ||
                tag === "a" ||
                role === "button" ||
                role === "link" ||
                (
                    tag === "input" &&
                    (
                        type.toLowerCase() ===
                            "submit" ||
                        type.toLowerCase() ===
                            "button" ||
                        type.toLowerCase() ===
                            "reset"
                    )
                );


            // =================================================
            // SAFE TEXT
            // =================================================

            let text = "";

            if (
                tag === "button" ||
                tag === "a" ||
                tag === "label" ||
                role === "button" ||
                role === "link"
            ) {

                text =
                    normalizeText(
                        element.innerText ||
                        element.textContent ||
                        ""
                    );
            }


            /*
             * SAFE SUBMIT CONTROL METADATA
             *
             * For button-like input controls only,
             * the HTML value attribute is UI metadata.
             *
             * We NEVER read input.value.
             */

            if (
                tag === "input" &&
                (
                    type.toLowerCase() ===
                        "submit" ||
                    type.toLowerCase() ===
                        "button" ||
                    type.toLowerCase() ===
                        "reset"
                )
            ) {

                text =
                    normalizeText(
                        element.getAttribute(
                            "value"
                        ) || ""
                    );
            }


            // =================================================
            // SAFE LABEL
            // =================================================

            let label =
                ariaLabel ||
                name ||
                placeholder ||
                "";


            if (
                tag === "input" &&
                (
                    type.toLowerCase() ===
                        "submit" ||
                    type.toLowerCase() ===
                        "button" ||
                    type.toLowerCase() ===
                        "reset"
                )
            ) {

                label =
                    text ||
                    label;
            }


            /*
             * Do not expose the word "password" unnecessarily
             * in ordinary metadata.
             */

            if (
                type.toLowerCase() ===
                "password"
            ) {

                label =
                    label.replace(
                        /password/gi,
                        "secure field"
                    );
            }


            // =================================================
            // DOCUMENT COORDINATES
            // =================================================

            const documentPosition =
                getDocumentCoordinates(
                    rect
                );


            // =================================================
            // COLLECT SAFE METADATA
            // =================================================

            collected.push({

                index,

                tag,

                type,

                role,

                label:
                    label.slice(
                        0,
                        120
                    ),

                text:
                    text.slice(
                        0,
                        120
                    ),

                x:
                    Math.round(
                        rect.left
                    ),

                y:
                    Math.round(
                        rect.top
                    ),

                width:
                    Math.round(
                        rect.width
                    ),

                height:
                    Math.round(
                        rect.height
                    ),

                in_viewport:
                    inViewport,

                document_x:
                    documentPosition.x,

                document_y:
                    documentPosition.y,

                is_button:
                    isButtonLike
            });
        }
    );


    // ========================================================
    // PRIORITIZE CURRENTLY VISIBLE ELEMENTS
    // ========================================================
    //
    // Visible controls are more immediately actionable.
    //
    // Among off-screen controls, button-like controls are
    // prioritized so things such as Submit remain available
    // to the planner even on long forms.
    // ========================================================

    collected.sort(
        (a, b) => {

            if (
                a.in_viewport !==
                b.in_viewport
            ) {

                return a.in_viewport
                    ? -1
                    : 1;
            }

            if (
                a.is_button !==
                b.is_button
            ) {

                return a.is_button
                    ? -1
                    : 1;
            }

            return (
                a.document_y -
                b.document_y
            );
        }
    );


    const limited =
        collected.slice(
            0,
            SIH_CONFIG.maxDOMElements
        );


    // Reassign stable indexes after sorting.
    limited.forEach(
        (element, index) => {

            element.index =
                index;
        }
    );


    console.log(
        "Safe DOM elements:",
        limited.length
    );

    console.log(
        "In viewport:",
        limited.filter(
            element =>
                element.in_viewport
        ).length
    );

    console.log(
        "Off-screen:",
        limited.filter(
            element =>
                !element.in_viewport
        ).length
    );


    return limited;
}


// ============================================================
// FIND ELEMENT METADATA
// ============================================================

function getElementMetadata(
    element
) {

    if (!element) {
        return null;
    }

    const rect =
        element.getBoundingClientRect();

    const tag =
        element.tagName
            ? element.tagName.toLowerCase()
            : "";

    const type =
        element.getAttribute(
            "type"
        ) || "";

    const role =
        element.getAttribute(
            "role"
        ) || "";

    const name =
        element.getAttribute(
            "name"
        ) || "";

    const id =
        element.getAttribute(
            "id"
        ) || "";

    const placeholder =
        element.getAttribute(
            "placeholder"
        ) || "";

    const ariaLabel =
        element.getAttribute(
            "aria-label"
        ) || "";

    return {

        tag,

        type,

        role,

        name,

        id,

        placeholder,

        ariaLabel,

        x:
            Math.round(
                rect.left
            ),

        y:
            Math.round(
                rect.top
            ),

        width:
            Math.round(
                rect.width
            ),

        height:
            Math.round(
                rect.height
            ),

        in_viewport:
            isInViewport(
                rect
            )
    };
}


// ============================================================
// PRIVACY OVERLAYS
// ============================================================
//
// These functions remain available for compatibility.
//
// IMPORTANT:
// runPrivacyEngine() DOES NOT call createPrivacyOverlays().
//
// Therefore the webpage remains completely normal.
// ============================================================

function removePrivacyOverlays() {

    privacyOverlays.forEach(
        overlay => {

            try {

                overlay.remove();

            } catch (_) {}
        }
    );

    privacyOverlays = [];


    document
        .querySelectorAll(
            "[data-sih-privacy-overlay='true']"
        )
        .forEach(
            element => {

                element.remove();
            }
        );
}


// ============================================================
// CREATE PRIVACY OVERLAY
// ============================================================

function createPrivacyOverlay(
    rect
) {

    if (!rect) {
        return null;
    }

    const overlay =
        document.createElement(
            "div"
        );

    overlay.dataset.sihPrivacyOverlay =
        "true";

    overlay.style.position =
        "fixed";

    overlay.style.left =
        `${rect.left}px`;

    overlay.style.top =
        `${rect.top}px`;

    overlay.style.width =
        `${rect.width}px`;

    overlay.style.height =
        `${rect.height}px`;

    overlay.style.background =
        SIH_CONFIG.overlayColor;

    overlay.style.zIndex =
        SIH_CONFIG.overlayZIndex;

    overlay.style.pointerEvents =
        "none";

    overlay.style.border =
        "1px solid #000";

    overlay.style.boxSizing =
        "border-box";


    document.body.appendChild(
        overlay
    );


    return overlay;
}


// ============================================================
// CREATE ALL PRIVACY OVERLAYS
// ============================================================

function createPrivacyOverlays() {

    removePrivacyOverlays();


    detections.forEach(
        detection => {

            const rect =
                detection.rect;

            if (!rect) {
                return;
            }


            const overlay =
                createPrivacyOverlay(
                    rect
                );


            if (overlay) {

                overlay.__sihRect =
                    rect;

                privacyOverlays.push(
                    overlay
                );
            }
        }
    );


    console.log(
        "Privacy overlays created:",
        privacyOverlays.length
    );
}


// ============================================================
// UPDATE OVERLAY POSITIONS
// ============================================================

function updateAllOverlayPositions() {

    privacyOverlays.forEach(
        overlay => {

            if (
                !overlay.__sihRect
            ) {
                return;
            }


            const rect =
                overlay.__sihRect;


            overlay.style.left =
                `${rect.left}px`;

            overlay.style.top =
                `${rect.top}px`;

            overlay.style.width =
                `${rect.width}px`;

            overlay.style.height =
                `${rect.height}px`;
        }
    );
}


// ============================================================
// PRIVACY ENGINE
// ============================================================

function runPrivacyEngine() {

    if (
        privacyEngineRunning
    ) {
        return;
    }


    privacyEngineRunning =
        true;


   try {

    // ========================================================
    // STAGE 2 PERCEPTION FOUNDATION
    // ========================================================
    //
    // Phase 1:
    //     DOM detector is active.
    //
    // Future:
    //     OCR detector
    //     Face detector
    //
    // All detectors remain local.
    // ========================================================

    if (
    window.SIHPerception &&
    typeof window.SIHPerception.runSync ===
        "function"
) {

    const perceptionResult =
        window.SIHPerception.runSync();

    if (
        perceptionResult &&
        Number.isFinite(
            perceptionResult.latencyMs
        )
    ) {

        console.log(
            "[PERCEPTION] Local perception latency:",
            perceptionResult.latencyMs.toFixed(2),
            "ms"
        );
    }

} else {

    // Safe Stage 1 fallback.
    // This protects the working prototype if the manager
    // is unavailable for any reason.

    detectDOMPII();
}


    /*
     * Keep webpage completely normal.
     *
     * PII masking is applied ONLY to captured screenshots.
     */

    removePrivacyOverlays();

    } catch (error) {

        console.error(
            "Privacy engine error:",
            error
        );

    } finally {

        privacyEngineRunning =
            false;
    }
}


// ============================================================
// REDACTION GEOMETRY + VERIFICATION
// ============================================================
//
// Regions are converted to INTEGER device pixels, rounded
// outward (floor / ceil). Fractional fillRect() coordinates are
// anti-aliased, which can leave partially visible PII pixels
// at the edges.
//
//   core  = the detected PII rectangle (must be fully black)
//   paint = core + REDACTION_PADDING safety margin
// ============================================================

function toCanvasRegions(
    rect,
    viewportWidth,
    viewportHeight,
    scaleX,
    scaleY,
    canvasWidth,
    canvasHeight,
    paddingCss
) {

    const values = [
        rect.left,
        rect.top,
        rect.right,
        rect.bottom
    ];

    if (
        !values.every(
            v => Number.isFinite(v)
        )
    ) {
        return { invalid: true };
    }

    // Completely outside the captured viewport: nothing to paint.
    if (
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= viewportWidth ||
        rect.top >= viewportHeight
    ) {
        return { outside: true };
    }

    const clamp =
        (v, max) =>
            Math.min(
                Math.max(v, 0),
                max
            );

    const build =
        pad => {

            const x0 =
                clamp(
                    Math.floor(
                        (rect.left - pad) *
                        scaleX
                    ),
                    canvasWidth
                );

            const y0 =
                clamp(
                    Math.floor(
                        (rect.top - pad) *
                        scaleY
                    ),
                    canvasHeight
                );

            const x1 =
                clamp(
                    Math.ceil(
                        (rect.right + pad) *
                        scaleX
                    ),
                    canvasWidth
                );

            const y1 =
                clamp(
                    Math.ceil(
                        (rect.bottom + pad) *
                        scaleY
                    ),
                    canvasHeight
                );

            return {
                x: x0,
                y: y0,
                width: Math.max(1, x1 - x0),
                height: Math.max(1, y1 - y0)
            };
        };

    return {
        core: build(0),
        paint: build(paddingCss)
    };
}

// Returns how many core regions still contain non-black pixels.
function countUnredactedRegions(
    context,
    coreRegions
) {

    let failed = 0;

    for (const region of coreRegions) {

        const { data } =
            context.getImageData(
                region.x,
                region.y,
                region.width,
                region.height
            );

        let ok = true;

        for (
            let i = 0;
            i < data.length;
            i += 4
        ) {

            if (
                data[i] > 8 ||
                data[i + 1] > 8 ||
                data[i + 2] > 8 ||
                data[i + 3] !== 255
            ) {
                ok = false;
                break;
            }
        }

        if (!ok) {
            failed++;
        }
    }

    return failed;
}


// ============================================================
// FACE -> IMAGE REGION RESOLUTION
// ============================================================
// Face detections are pixel regions from the screenshot.
// For privacy, a detected face should redact the image element
// containing that face, not the entire screenshot.
// ============================================================

function getImageRegionForFace(
    faceRect,
    viewportWidth,
    viewportHeight
) {

    if (
        !faceRect ||
        !isValidDetectionRect(faceRect)
    ) {
        return null;
    }

    const faceCenterX =
        (faceRect.left + faceRect.right) / 2;

    const faceCenterY =
        (faceRect.top + faceRect.bottom) / 2;

    const faceWidth =
        Math.max(1, faceRect.right - faceRect.left);

    const faceHeight =
        Math.max(1, faceRect.bottom - faceRect.top);

    const faceArea =
        faceWidth * faceHeight;

    let bestImage = null;
    let bestScore = 0;

    const images =
        Array.from(
            document.images || []
        );

    for (const imageElement of images) {

        if (!imageElement) {
            continue;
        }

        const rect =
            imageElement.getBoundingClientRect();

        if (
            !Number.isFinite(rect.left) ||
            !Number.isFinite(rect.top) ||
            !Number.isFinite(rect.right) ||
            !Number.isFinite(rect.bottom) ||
            rect.width <= 0 ||
            rect.height <= 0
        ) {
            continue;
        }

        // Ignore images that are not visible in the current viewport.
        if (
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= viewportWidth ||
            rect.top >= viewportHeight
        ) {
            continue;
        }

        const intersectionLeft =
            Math.max(
                faceRect.left,
                rect.left
            );

        const intersectionTop =
            Math.max(
                faceRect.top,
                rect.top
            );

        const intersectionRight =
            Math.min(
                faceRect.right,
                rect.right
            );

        const intersectionBottom =
            Math.min(
                faceRect.bottom,
                rect.bottom
            );

        const intersectionWidth =
            Math.max(
                0,
                intersectionRight - intersectionLeft
            );

        const intersectionHeight =
            Math.max(
                0,
                intersectionBottom - intersectionTop
            );

        const intersectionArea =
            intersectionWidth * intersectionHeight;

        const centerInside =
            faceCenterX >= rect.left &&
            faceCenterX <= rect.right &&
            faceCenterY >= rect.top &&
            faceCenterY <= rect.bottom;

        if (
            intersectionArea <= 0 &&
            !centerInside
        ) {
            continue;
        }

        // Prefer an image that contains the face center and covers
        // the largest portion of the detected face.
        const overlapScore =
            intersectionArea / faceArea;

        const score =
            (centerInside ? 2 : 0) +
            overlapScore;

        if (score > bestScore) {
            bestScore = score;
            bestImage = rect;
        }
    }

    if (!bestImage) {
        return null;
    }

    return {
        left: bestImage.left,
        top: bestImage.top,
        right: bestImage.right,
        bottom: bestImage.bottom,
        width: bestImage.width,
        height: bestImage.height
    };
}


function getFaceImageRegions(
    detectionList,
    viewportWidth,
    viewportHeight
) {

    const regions = [];
    const seen = new Set();

    const detections =
        Array.isArray(detectionList)
            ? detectionList
            : [];

    for (const detection of detections) {

        if (
            !detection ||
            detection.type !== "FACE" ||
            !detection.rect
        ) {
            continue;
        }

        const imageRect =
            getImageRegionForFace(
                detection.rect,
                viewportWidth,
                viewportHeight
            );

        /*
         * IMPORTANT:
         *
         * A face must belong to an actual image.
         *
         * Do NOT fall back to the face rectangle.
         * Otherwise false-positive BlazeFace detections
         * outside images create black boxes in the page.
         */

        if (!imageRect) {
            continue;
        }

        const key = [
            Math.round(imageRect.left * 10),
            Math.round(imageRect.top * 10),
            Math.round(imageRect.right * 10),
            Math.round(imageRect.bottom * 10)
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        regions.push(imageRect);
    }

    return regions;
}

// ============================================================
// SCREENSHOT SANITIZATION
// PHASE 2.5 â€” ADVANCED REDACTION + VERIFICATION
// ============================================================
//
// Screenshot coordinates are viewport-relative.
//
// The screenshot captured by Chrome represents the current
// viewport, therefore getBoundingClientRect() coordinates map
// directly after scaling.
//
// Only detections belonging to the captured viewport are useful.
// Off-screen detections are naturally clipped by the canvas.
//
// Privacy pipeline:
//
//   Unified PII
//        â†“
//   Region classification
//        â†“
//   Viewport clipping
//        â†“
//   Screenshot redaction
//        â†“
//   Pixel verification
//        â†“
//   Privacy Gate
//        â†“
//   Encode sanitized image
//
// IMPORTANT:
// - Live webpage is NEVER visually masked.
// - Only screenshots are redacted.
// - Out-of-view PII is tracked separately.
// - Invalid/unredactable PII fails closed.
// - Failed verification blocks transmission.
// ============================================================

function sanitizeScreenshot(
    screenshot,
    detectionList
) {

    const benchmarkStart =
        performance.now();

    benchmarkMetrics.screenshotBeforeBytes =
        getDataUrlByteSize(
            screenshot
        );

    // ========================================================
    // RESET PHASE 2.5 METRICS
    // ========================================================

    benchmarkMetrics.unifiedPIIRegions =
        Array.isArray(detectionList)
            ? detectionList.length
            : 0;

    benchmarkMetrics.inCaptureRegions = 0;

    benchmarkMetrics.outOfViewRegions = 0;

    benchmarkMetrics.invalidRegions = 0;

    benchmarkMetrics.redactedRegions = 0;

    benchmarkMetrics.verificationRegions = 0;

    benchmarkMetrics.verificationFailedRegions = 0;

    benchmarkMetrics.verificationPassed = null;

    benchmarkMetrics.privacyGatePassed = null;


    return new Promise(
        (
            resolve,
            reject
        ) => {

            try {

                if (!screenshot) {

                    benchmarkMetrics.privacyGatePassed =
                        false;

                    reject(
                        new Error(
                            "Screenshot data is missing"
                        )
                    );

                    return;
                }


                const image =
                    new Image();


                image.onload =
                    () => {

                        try {

                            const canvas =
                                document.createElement(
                                    "canvas"
                                );


                            canvas.width =
                                image.naturalWidth;

                            canvas.height =
                                image.naturalHeight;


                            const context =
                                canvas.getContext(
                                    "2d",
                                    {
                                        willReadFrequently:
                                            true
                                    }
                                );


                            if (!context) {

                                benchmarkMetrics.privacyGatePassed =
                                    false;

                                reject(
                                    new Error(
                                        "Could not create canvas context"
                                    )
                                );

                                return;
                            }


                            context.drawImage(
                                image,
                                0,
                                0
                            );


                            const viewportWidth =
                                window.innerWidth;

                            const viewportHeight =
                                window.innerHeight;


                            if (
                                viewportWidth <= 0 ||
                                viewportHeight <= 0
                            ) {

                                benchmarkMetrics.privacyGatePassed =
                                    false;

                                reject(
                                    new Error(
                                        "Invalid viewport dimensions"
                                    )
                                );

                                return;
                            }


                            const scaleX =
                                canvas.width /
                                viewportWidth;

                            const scaleY =
                                canvas.height /
                                viewportHeight;


                            // ====================================================
                            // REGION CLASSIFICATION
                            // ====================================================

                            const paintRegions = [];

                            const coreRegions = [];

                            let outOfViewCount = 0;

                            let invalidCount = 0;


                            // A face is redacted at the image-element level.
                            // This keeps the rest of the screenshot visible.
                            const faceImageRects =
                                getFaceImageRegions(
                                    detectionList,
                                    viewportWidth,
                                    viewportHeight
                                );


                            faceImageRects.forEach(
                                rect => {

                                    const regions =
                                        toCanvasRegions(
                                            rect,
                                            viewportWidth,
                                            viewportHeight,
                                            scaleX,
                                            scaleY,
                                            canvas.width,
                                            canvas.height,
                                            REDACTION_PADDING
                                        );

                                    if (regions.invalid) {
                                        invalidCount++;
                                        return;
                                    }

                                    if (regions.outside) {
                                        outOfViewCount++;
                                        return;
                                    }

                                    if (
                                        !regions.core ||
                                        !regions.paint
                                    ) {
                                        invalidCount++;
                                        return;
                                    }

                                    paintRegions.push(
                                        regions.paint
                                    );

                                    coreRegions.push(
                                        regions.core
                                    );
                                }
                            );


                            (
                                Array.isArray(
                                    detectionList
                                )
                                    ? detectionList
                                    : []
                            ).forEach(
                                detection => {

                                    if (!detection) {

                                        invalidCount++;

                                        return;
                                    }


                                    // FACE detections are already represented by
                                    // their containing image region above. Do not
                                    // also paint the small face rectangle.
                                    if (
                                        detection.type === "FACE"
                                    ) {
                                        return;
                                    }


                                    // ------------------------------------------------
                                    // Missing geometry
                                    // ------------------------------------------------

                                    if (
                                        !detection.rect
                                    ) {

                                        invalidCount++;

                                        return;
                                    }


                                    const regions =
                                        toCanvasRegions(
                                            detection.rect,
                                            viewportWidth,
                                            viewportHeight,
                                            scaleX,
                                            scaleY,
                                            canvas.width,
                                            canvas.height,
                                            REDACTION_PADDING
                                        );


                                    // ------------------------------------------------
                                    // Invalid geometry
                                    // ------------------------------------------------

                                    if (
                                        regions.invalid
                                    ) {

                                        invalidCount++;

                                        return;
                                    }


                                    // ------------------------------------------------
                                    // Completely outside viewport
                                    //
                                    // This is NOT a redaction failure.
                                    // It is tracked separately because the
                                    // current screenshot cannot contain that
                                    // region.
                                    // ------------------------------------------------

                                    if (
                                        regions.outside
                                    ) {

                                        outOfViewCount++;

                                        return;
                                    }


                                    // ------------------------------------------------
                                    // Valid region inside / intersecting capture
                                    // ------------------------------------------------

                                    if (
                                        !regions.core ||
                                        !regions.paint
                                    ) {

                                        invalidCount++;

                                        return;
                                    }


                                    paintRegions.push(
                                        regions.paint
                                    );

                                    coreRegions.push(
                                        regions.core
                                    );
                                }
                            );


                            benchmarkMetrics.inCaptureRegions =
                                coreRegions.length;

                            benchmarkMetrics.outOfViewRegions =
                                outOfViewCount;

                            benchmarkMetrics.invalidRegions =
                                invalidCount;


                            // ====================================================
                            // REDACT
                            // ====================================================

                            context.fillStyle =
                                "#000000";


                            paintRegions.forEach(
                                region => {

                                    context.fillRect(
                                        region.x,
                                        region.y,
                                        region.width,
                                        region.height
                                    );

                                }
                            );


                            benchmarkMetrics.redactedRegions =
                                paintRegions.length;


                            // ====================================================
                            // VERIFY REDACTION
                            // ====================================================

                            // Force pending canvas operations to complete.
                            context.getImageData(
                                0,
                                0,
                                1,
                                1
                            );


                            const verifyStart =
                                performance.now();


                            const pixelFailures =
                                countUnredactedRegions(
                                    context,
                                    coreRegions
                                );


                            // Invalid regions are privacy failures.
                            const failedRegions =
                                pixelFailures +
                                invalidCount;


                            benchmarkMetrics.verificationLatencyMs =
                                performance.now() -
                                verifyStart;


                            benchmarkMetrics.verificationRegions =
                                coreRegions.length +
                                invalidCount;


                            benchmarkMetrics.verificationFailedRegions =
                                failedRegions;


                            benchmarkMetrics.verificationPassed =
                                failedRegions === 0;


                            // ====================================================
                            // PRIVACY GATE
                            // ====================================================
                            //
                            // PASS:
                            //   Every region that belongs to this capture
                            //   was successfully redacted.
                            //
                            // OUT-OF-VIEW:
                            //   Not a failure because it cannot exist inside
                            //   this screenshot.
                            //
                            // FAIL:
                            //   Invalid geometry OR failed pixel verification.
                            //
                            // ====================================================

                            const privacyGatePassed =
                                (
                                    failedRegions === 0
                                );

                            benchmarkMetrics.privacyGatePassed =
                                privacyGatePassed;


                            console.log(
                                "[REDACTION] Unified PII       :",
                                benchmarkMetrics.unifiedPIIRegions
                            );

                            console.log(
                                "[REDACTION] In-capture        :",
                                benchmarkMetrics.inCaptureRegions
                            );

                            console.log(
                                "[REDACTION] Out-of-view       :",
                                benchmarkMetrics.outOfViewRegions
                            );

                            console.log(
                                "[REDACTION] Invalid           :",
                                benchmarkMetrics.invalidRegions
                            );

                            console.log(
                                "[REDACTION] Redacted          :",
                                benchmarkMetrics.redactedRegions
                            );


                            console.log(
                                "[BENCHMARK] Redaction verification:",
                                benchmarkMetrics.verificationPassed
                                    ? "PASS"
                                    : "FAIL",
                                `(${benchmarkMetrics.verificationRegions} regions,`,
                                `${failedRegions} failed,`,
                                `${benchmarkMetrics.verificationLatencyMs.toFixed(2)} ms)`
                            );


                            console.log(
                                "[PRIVACY GATE]:",
                                privacyGatePassed
                                    ? "PASS"
                                    : "FAIL"
                            );


                            // ====================================================
                            // FAIL CLOSED
                            // ====================================================

                            if (
                                !privacyGatePassed
                            ) {

                                // NEVER return the screenshot.
                                // This prevents transmission of an image
                                // whose PII redaction could not be verified.

                                reject(
                                    new Error(
                                        "Privacy gate failed: " +
                                        failedRegions +
                                        " region(s) could not be safely redacted."
                                    )
                                );

                                return;
                            }


                            // ====================================================
                            // IMAGE FORMAT BENCHMARK
                            // ====================================================
                            //
                            // Only reached after privacy verification PASS.
                            // ====================================================

                            const pngBenchmarkStart =
                                performance.now();


                            const sanitizedPng =
                                canvas.toDataURL(
                                    "image/png"
                                );


                            const pngEncodingLatencyMs =
                                performance.now() -
                                pngBenchmarkStart;


                            const pngBytes =
                                getDataUrlByteSize(
                                    sanitizedPng
                                );


                            benchmarkMetrics.screenshotPngBytes =
                                pngBytes;


                            const webpResult =
                                encodeSanitizedWebP(
                                    canvas
                                );


                            benchmarkMetrics.screenshotWebpBytes =
                                webpResult.bytes;


                            // ====================================================
                            // SELECT TRANSMISSION FORMAT
                            // ====================================================

                            let sanitizedScreenshot = "";

                            let selectedFormat = "";

                            let selectedBytes = 0;


                            if (
                                SIH_CONFIG.transmitWebP &&
                                webpResult.dataUrl &&
                                webpResult.bytes > 0 &&
                                webpResult.bytes < pngBytes
                            ) {

                                sanitizedScreenshot =
                                    webpResult.dataUrl;

                                selectedFormat =
                                    "image/webp";

                                selectedBytes =
                                    webpResult.bytes;

                            } else {

                                sanitizedScreenshot =
                                    sanitizedPng;

                                selectedFormat =
                                    "image/png";

                                selectedBytes =
                                    pngBytes;
                            }


                            // ====================================================
                            // FINAL TRANSMISSION SAFETY CHECK
                            // ====================================================

                            if (
                                !sanitizedScreenshot ||
                                selectedBytes <= 0
                            ) {

                                benchmarkMetrics.privacyGatePassed =
                                    false;

                                reject(
                                    new Error(
                                        "Privacy gate failed: sanitized image could not be encoded."
                                    )
                                );

                                return;
                            }


                            benchmarkMetrics.screenshotAfterBytes =
                                selectedBytes;

                            benchmarkMetrics.screenshotFormat =
                                selectedFormat;

                            benchmarkMetrics.pngEncodeLatencyMs =
                                pngEncodingLatencyMs;

                            benchmarkMetrics.webpEncodeLatencyMs =
                                webpResult.latencyMs;

                            benchmarkMetrics.compressionLatencyMs =
                                pngEncodingLatencyMs +
                                webpResult.latencyMs;


                            // ====================================================
                            // COMPRESSION RATIO
                            // ====================================================

                            benchmarkMetrics.compressionRatio =
                                (
                                    benchmarkMetrics.screenshotBeforeBytes > 0 &&
                                    selectedBytes > 0
                                )
                                    ? selectedBytes /
                                      benchmarkMetrics.screenshotBeforeBytes
                                    : 0;


                            // ====================================================
                            // BENCHMARK LOGGING
                            // ====================================================

                            console.log(
                                "[BENCHMARK] PNG size:",
                                (pngBytes / 1024).toFixed(2),
                                "KB"
                            );


                            console.log(
                                "[BENCHMARK] WebP size:",
                                (webpResult.bytes / 1024).toFixed(2),
                                "KB"
                            );


                            console.log(
                                "[BENCHMARK] Selected format:",
                                selectedFormat
                            );


                            console.log(
                                "[BENCHMARK] Selected size:",
                                (selectedBytes / 1024).toFixed(2),
                                "KB"
                            );


                            console.log(
                                "[BENCHMARK] Compression latency:",
                                benchmarkMetrics.compressionLatencyMs.toFixed(2),
                                "ms",
                                `(PNG ${pngEncodingLatencyMs.toFixed(2)} ms,`,
                                `WebP ${webpResult.latencyMs.toFixed(2)} ms)`
                            );


                            console.log(
                                "[BENCHMARK] Compression ratio:",
                                benchmarkMetrics.compressionRatio.toFixed(4)
                            );


                            // Redaction latency excludes verification
                            // and compression.
                            benchmarkMetrics.redactionLatencyMs =
                                (
                                    performance.now() -
                                    benchmarkStart
                                ) -
                                benchmarkMetrics.verificationLatencyMs -
                                benchmarkMetrics.compressionLatencyMs;


                            console.log(
                                "[BENCHMARK] Redaction latency:",
                                benchmarkMetrics.redactionLatencyMs.toFixed(2),
                                "ms"
                            );


                            console.log(
                                "[BENCHMARK] Screenshot before:",
                                (
                                    benchmarkMetrics.screenshotBeforeBytes /
                                    1024
                                ).toFixed(2),
                                "KB"
                            );


                            console.log(
                                "[BENCHMARK] Screenshot after:",
                                (
                                    benchmarkMetrics.screenshotAfterBytes /
                                    1024
                                ).toFixed(2),
                                "KB"
                            );


                            // ====================================================
                            // FINAL PRIVACY ASSERTION
                            // ====================================================

                            if (
                                benchmarkMetrics.privacyGatePassed !== true
                            ) {

                                reject(
                                    new Error(
                                        "Privacy gate was not satisfied."
                                    )
                                );

                                return;
                            }


                            // ====================================================
                            // SAFE RETURN
                            // ====================================================

                            resolve(
                                sanitizedScreenshot
                            );


                        } catch (error) {

                            benchmarkMetrics.privacyGatePassed =
                                false;

                            reject(
                                error
                            );
                        }
                    };


                image.onerror =
                    () => {

                        benchmarkMetrics.privacyGatePassed =
                            false;

                        reject(
                            new Error(
                                "Could not load screenshot image"
                            )
                        );
                    };


                image.src =
                    screenshot;


            } catch (error) {

                benchmarkMetrics.privacyGatePassed =
                    false;

                reject(
                    error
                );
            }
        }
    );
}


// ============================================================
// CHECK WHETHER POINT IS INSIDE PII
// ============================================================

function isPointInsideDetection(
    x,
    y
) {

    return detections.some(
        detection => {

            const rect =
                detection.rect;

            if (!rect) {
                return false;
            }

            return (
                x >= rect.left &&
                x <= rect.right &&
                y >= rect.top &&
                y <= rect.bottom
            );
        }
    );
}


// ============================================================
// CHECK WHETHER POINT IS IN VIEWPORT
// ============================================================

function isPointInViewport(
    x,
    y
) {

    return (
        Number.isFinite(
            Number(x)
        ) &&
        Number.isFinite(
            Number(y)
        ) &&
        Number(x) >= 0 &&
        Number(y) >= 0 &&
        Number(x) <= window.innerWidth &&
        Number(y) <= window.innerHeight
    );
}

// ============================================================
// BROWSER AGENT SAFETY GATE
// ============================================================
//
// Every browser action must pass local validation before it
// reaches the actual DOM executor.
//
// The planner is NOT trusted to directly control the browser.
//
// Safety checks performed here include:
// - supported action type
// - valid coordinates
// - viewport bounds
// - visible target
// - interactable target
// - disabled / readonly protection
// - password / OTP / credential protection
// - submit-target validation
// - bounded scroll
// - bounded wait
//
// IMPORTANT:
// These checks happen locally inside the browser.
// No sensitive field value is read.
// ============================================================

const ALLOWED_BROWSER_ACTIONS = new Set([
    "click",
    "type",
    "scroll",
    "wait",
    "none"
]);


const SENSITIVE_TARGET_PATTERN =
    /\b(?:password|passwd|passcode|credential|credentials|secret|otp|one[-\s]?time[-\s]?password|one[-\s]?time[-\s]?code|security[-\s]?code|verification[-\s]?code|auth[-\s]?code|pin)\b/i;


// ============================================================
// SAFE METADATA EXTRACTION
// ============================================================

function getElementSafetyMetadata(element) {

    if (!element) {
        return {
            tag: "",
            type: "",
            role: "",
            name: "",
            id: "",
            placeholder: "",
            ariaLabel: "",
            autocomplete: ""
        };
    }


    return {

        tag:
            String(
                element.tagName || ""
            ).toLowerCase(),

        type:
            String(
                element.getAttribute("type") || ""
            ).toLowerCase(),

        role:
            String(
                element.getAttribute("role") || ""
            ).toLowerCase(),

        name:
            String(
                element.getAttribute("name") || ""
            ).toLowerCase(),

        id:
            String(
                element.getAttribute("id") || ""
            ).toLowerCase(),

        placeholder:
            String(
                element.getAttribute("placeholder") || ""
            ).toLowerCase(),

        ariaLabel:
            String(
                element.getAttribute("aria-label") || ""
            ).toLowerCase(),

        autocomplete:
            String(
                element.getAttribute("autocomplete") || ""
            ).toLowerCase()
    };
}


// ============================================================
// SENSITIVE TARGET CHECK
// ============================================================
//
// This function NEVER reads element.value.
//
// Only HTML metadata is inspected.
// ============================================================

function isSensitiveTarget(element) {

    if (!element) {
        return true;
    }


    const metadata =
        getElementSafetyMetadata(
            element
        );

     if (
        metadata.tag === "button" ||
        (
            metadata.tag === "input" &&
            metadata.type === "submit"
        ) ||
        metadata.role === "button"
    ) {
        return false;
    }
    // Native password field.
    if (
        metadata.type === "password"
    ) {
        return true;
    }


    // Sensitive autocomplete tokens.
    if (
        metadata.autocomplete === "one-time-code" ||
        metadata.autocomplete === "cc-csc" ||
        metadata.autocomplete === "cc-cvc"
    ) {
        return true;
    }


    const combined =
        [
            metadata.type,
            metadata.name,
            metadata.id,
            metadata.placeholder,
            metadata.ariaLabel,
            metadata.autocomplete
        ]
            .join(" ")
            .trim();


    return SENSITIVE_TARGET_PATTERN.test(
        combined
    );
}


// ============================================================
// VISIBLE TARGET CHECK
// ============================================================

function isInteractableElement(element) {

    if (!element) {
        return false;
    }


    if (!isVisible(element)) {
        return false;
    }


    if (
        element.disabled === true
    ) {
        return false;
    }


    if (
        element.hasAttribute &&
        element.hasAttribute("aria-disabled") &&
        String(
            element.getAttribute(
                "aria-disabled"
            )
        ).toLowerCase() === "true"
    ) {
        return false;
    }


    const style =
        window.getComputedStyle(
            element
        );


    if (
        style.pointerEvents === "none"
    ) {
        return false;
    }


    return true;
}


// ============================================================
// CLICKABLE TARGET CHECK
// ============================================================

function isClickableElement(element) {

    if (!element) {
        return false;
    }

    const tag =
        String(
            element.tagName || ""
        ).toLowerCase();

    const type =
        String(
            element.getAttribute?.("type") || ""
        ).toLowerCase();

    const role =
        String(
            element.getAttribute?.("role") || ""
        ).toLowerCase();

    // Standard clickable HTML controls.
    if (
        tag === "button" ||
        tag === "a" ||
        tag === "select"
    ) {
        return true;
    }

    // Textarea is not a click action target for the agent.
    if (
        tag === "textarea"
    ) {
        return false;
    }

    // Only explicitly clickable input types.
    if (
        tag === "input"
    ) {

        return (
            type === "button" ||
            type === "submit" ||
            type === "reset" ||
            type === "checkbox" ||
            type === "radio" ||
            type === "file" ||
            type === "image"
        );
    }

    // ARIA controls.
    if (
        role === "button" ||
        role === "link" ||
        role === "menuitem" ||
        role === "tab"
    ) {
        return true;
    }

    // Elements with an explicit click handler.
    if (
        typeof element.onclick === "function"
    ) {
        return true;
    }

    return false;
}


// ============================================================
// SUBMIT TARGET CHECK
// ============================================================
//
// Used when the agent is explicitly performing a submit flow.
//
// We inspect metadata and visible UI text only.
// We NEVER inspect input.value.
// ============================================================

// ============================================================
// SUBMIT TARGET CHECK
// ============================================================
//
// Used when the agent is explicitly performing a submit flow.
//
// We inspect only safe UI metadata / visible button text.
// We NEVER inspect input.value.
// ============================================================

function isSubmitElement(element) {

    if (!element) {
        return false;
    }

    const tag =
        String(
            element.tagName || ""
        ).toLowerCase();

    const type =
        String(
            element.getAttribute?.("type") || ""
        ).toLowerCase();

    const role =
        String(
            element.getAttribute?.("role") || ""
        ).toLowerCase();

    const text =
        normalizeText(
            element.innerText ||
            element.textContent ||
            element.getAttribute?.("aria-label") ||
            ""
        ).toLowerCase();

    // --------------------------------------------------------
    // Native input submit
    // --------------------------------------------------------

    if (
        tag === "input" &&
        type === "submit"
    ) {
        return true;
    }

    // --------------------------------------------------------
    // Button elements
    //
    // Accept:
    //   <button>
    //   <button type="submit">
    //   <button type="button">
    //
    // BUT ONLY when the visible label explicitly indicates
    // a submit/continue/apply/finish/confirm action.
    // --------------------------------------------------------

    if (tag === "button") {

        const hasSubmitLabel =
            /\bsubmit\b|\bapply\b|\bcontinue\b|\bfinish\b|\bconfirm\b/.test(
                text
            );

        if (
            hasSubmitLabel &&
            (
                type === "" ||
                type === "submit" ||
                type === "button"
            )
        ) {
            return true;
        }
    }

    // --------------------------------------------------------
    // ARIA buttons
    // --------------------------------------------------------

    if (
        role === "button"
    ) {

        const hasSubmitLabel =
            /\bsubmit\b|\bapply\b|\bcontinue\b|\bfinish\b|\bconfirm\b/.test(
                text
            );

        if (hasSubmitLabel) {
            return true;
        }
    }

    return false;
}

// ============================================================
// ACTION TYPE VALIDATION
// ============================================================

function validateActionType(
    actionType
) {

    const normalized =
        String(
            actionType || ""
        )
            .toLowerCase()
            .trim();


    if (
        !ALLOWED_BROWSER_ACTIONS.has(
            normalized
        )
    ) {

        return {

            valid: false,

            error:
                `Unsupported browser action: ${
                    normalized || "missing"
                }`
        };
    }


    return {

        valid: true,

        action:
            normalized
    };
}


// ============================================================
// COORDINATE VALIDATION
// ============================================================

function validateActionCoordinates(
    target
) {

    if (
        !target ||
        target.x === undefined ||
        target.y === undefined
    ) {

        return {

            valid: false,

            error:
                "Action target coordinates are missing"
        };
    }


    const x =
        Number(target.x);

    const y =
        Number(target.y);


    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y)
    ) {

        return {

            valid: false,

            error:
                "Action target coordinates are invalid"
        };
    }


    if (
        !isPointInViewport(
            x,
            y
        )
    ) {

        return {

            valid: false,

            requiresScroll: true,

            error:
                "Action target is outside the current viewport",

            x,
            y
        };
    }


    return {

        valid: true,

        x,
        y
    };
}


// ============================================================
// CLICK TARGET VALIDATION
// ============================================================

function validateClickTarget(action) {
    if (!action || typeof action !== "object") {
        return {
            valid: false,
            reason: "Invalid action object."
        };
    }

    if (action.type !== "click") {
        return {
            valid: false,
            reason: "Action is not a click."
        };
    }

    const x = Number(action.x);
    const y = Number(action.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {
            valid: false,
            reason: "Click coordinates are invalid."
        };
    }

    if (x < 0 || y < 0) {
        return {
            valid: false,
            reason: "Click coordinates cannot be negative."
        };
    }

    const target = document.elementFromPoint(x, y);

    if (!target) {
        return {
    valid: false,
    retryable: true,
    reason:
        "No DOM element exists at the requested coordinates."
};
    }

    const clickable = target.closest(
        'button, a, input, select, textarea, [role="button"], [role="link"], [onclick]'
    );

    if (!clickable) {
        return {
    valid: false,
    retryable: true,
    reason:
        "Target is not a clickable element."
};
    }

    /*
     * HARD PRIVACY / SAFETY BLOCK
     *
     * Never allow the agent to click password,
     * OTP, credential, PIN, or security-code fields.
     */
    if (isSensitiveTarget(clickable)) {
        return {
            valid: false,
            reason: "Click blocked because target is a sensitive security field."
        };
    }

    /*
     * SUBMIT SAFETY GATE
     *
     * The planner may provide submitIntent=true when
     * the current task explicitly requires submitting.
     *
     * If submitIntent is true, ONLY an actual submit
     * control is allowed.
     */
    if (action.submitIntent === true) {
        if (!isSubmitElement(clickable)) {
            return {
    valid: false,
    retryable: true,
    reason:
        "Submit action blocked because target is not a submit control."
};
        }
    }

    /*
     * Optional target metadata validation.
     *
     * This prevents a planner from selecting a sensitive
     * field even when coordinates happen to point there.
     */
    const metadata = {
        tagName: String(clickable.tagName || "").toLowerCase(),
        type: String(clickable.getAttribute?.("type") || "").toLowerCase(),
        name: String(clickable.getAttribute?.("name") || "").toLowerCase(),
        id: String(clickable.id || "").toLowerCase(),
        ariaLabel: String(
            clickable.getAttribute?.("aria-label") || ""
        ).toLowerCase()
    };

    const sensitivePattern =
        /\b(password|passwd|passcode|credential|credentials|otp|one[-\s]?time[-\s]?password|security[-\s]?code|pin|secret)\b/i;

    const metadataText = [
        metadata.tagName,
        metadata.type,
        metadata.name,
        metadata.id,
        metadata.ariaLabel
    ].join(" ");

    if (sensitivePattern.test(metadataText)) {
        return {
            valid: false,
            reason: "Click blocked because target metadata indicates a sensitive field."
        };
    }

    return {
        valid: true,
        element: clickable,
        x,
        y
    };
}


// ============================================================
// TYPE TARGET VALIDATION
// ============================================================

function validateTypeTarget(
    target,
    value
) {

    if (
        value === null ||
        value === undefined ||
        String(value).length === 0
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing requires an explicit non-empty value"
        };
    }


    const coordinates =
        validateActionCoordinates(
            target
        );


    if (
        !coordinates.valid
    ) {
        return coordinates;
    }


    const element =
        document.elementFromPoint(
            coordinates.x,
            coordinates.y
        );


    if (!element) {

        return {

            valid: false,

            retryable: true,

            error:
                "No DOM element exists at the requested typing coordinates"
        };
    }


    const input =
        element.closest?.(
            "input, textarea"
        );


    if (!input) {

        return {

            valid: false,

            retryable: true,

            error:
                "Typing target is not an input or textarea"
        };
    }


    if (
        !isInteractableElement(
            input
        )
    ) {

        return {

            valid: false,

            retryable: true,

            error:
                "Typing target is not visible or interactable"
        };
    }


    if (
        isSensitiveTarget(
            input
        )
    ) {

        return {
    valid: false,
    unsafe: true,
    error:
        "Typing blocked on password, OTP, credential or security field"
};
    }


    if (
        input.readOnly === true
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing blocked on read-only field"
        };
    }


    if (
        input.disabled === true
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing blocked on disabled field"
        };
    }


    return {

        valid: true,

        element:
            input
    };
}


// ============================================================
// SCROLL VALIDATION
// ============================================================

function validateScrollAmount(
    value
) {

    const amount =
        Number(value);


    if (
        !Number.isFinite(
            amount
        )
    ) {

        return {

            valid: false,

            error:
                "Scroll amount is invalid"
        };
    }


    if (
        amount === 0
    ) {

        return {

            valid: false,

            error:
                "Scroll amount cannot be zero"
        };
    }


    const boundedAmount =
        Math.max(
            -SIH_CONFIG.maxScrollAmount,
            Math.min(
                SIH_CONFIG.maxScrollAmount,
                amount
            )
        );


    return {

        valid: true,

        amount:
            boundedAmount
    };
}


// ============================================================
// WAIT VALIDATION
// ============================================================

function validateWaitDuration(
    value
) {

    const milliseconds =
        Number(value);


    if (
        !Number.isFinite(
            milliseconds
        )
    ) {

        return {

            valid: false,

            error:
                "Wait duration is invalid"
        };
    }


    const boundedDuration =
        Math.max(
            SIH_CONFIG.minWaitMs,
            Math.min(
                SIH_CONFIG.maxWaitMs,
                milliseconds
            )
        );


    return {

        valid: true,

        milliseconds:
            boundedDuration
    };
}


// ============================================================
// COMPLETE ACTION SAFETY VALIDATOR
// ============================================================
//
// This is the single local gate for browser actions.
//
// ============================================================

function validateBrowserAction(
    action
) {

    if (
        !action ||
        typeof action !== "object"
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Browser action is missing or malformed"
        };
    }


    const actionType =
        String(
            action.action ||
            action.type ||
            ""
        )
            .toLowerCase()
            .trim();


    const typeValidation =
        validateActionType(
            actionType
        );


    if (
        !typeValidation.valid
    ) {

        return typeValidation;
    }


    // --------------------------------------------------------
    // NONE
    // --------------------------------------------------------

    if (
        actionType === "none"
    ) {

        return {

            valid: true,

            action:
                "none"
        };
    }


        // --------------------------------------------------------
    // CLICK
    // --------------------------------------------------------

    if (
    actionType === "click"
) {

    const submitIntent =
        action?.submitIntent === true ||
        action?.target?.submitIntent === true;

    // --------------------------------------------------------
    // SUBMIT INTENT
    // --------------------------------------------------------
    //
    // For Submit actions, the AI coordinates are NOT trusted
    // as the actual click target.
    //
    // executeClick() will resolve the real Submit control
    // locally using DOM semantics and safety checks.
    //
    // Therefore we must NOT run validateClickTarget()
    // against the AI coordinates here.
    // --------------------------------------------------------

    if (submitIntent) {

        return {
            valid: true,
            action: "click",
            submitIntent: true
        };
    }

    // --------------------------------------------------------
    // NORMAL CLICK
    // --------------------------------------------------------

    const target = {
        x:
            action?.target?.x !== undefined
                ? action.target.x
                : action?.x,

        y:
            action?.target?.y !== undefined
                ? action.target.y
                : action?.y,

        submitIntent: false
    };

    return {
        action: "click",

        ...validateClickTarget(
            target
        )
    };

    }
    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    if (
        actionType === "type"
    ) {

        const target =
            action.target ||
            {
                x: action.x,
                y: action.y
            };


        const value =
            action.value !== undefined
                ? action.value
                : action.text;


        return {
            action: "type",
            ...validateTypeTarget(
                target,
                value
            )
        };
    }


    // --------------------------------------------------------
    // SCROLL
    // --------------------------------------------------------

    if (
        actionType === "scroll"
    ) {

        const amount =
            action.amount !== undefined
                ? action.amount
                : action.value;


        return {
            action: "scroll",
            ...validateScrollAmount(
                amount
            )
        };
    }


    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    if (
        actionType === "wait"
    ) {

        const duration =
            action.amount !== undefined
                ? action.amount
                : action.value;


        return {
            action: "wait",
            ...validateWaitDuration(
                duration
            )
        };
    }


    return {

        valid: false,

        unsafe: true,

        error:
            "Browser action failed safety validation"
    };
}
// ============================================================
// SCROLL TO ELEMENT
// ============================================================
//
// This helper is intentionally local.
//
// It can be used when the extension has an actual DOM target.
//
// The current planner architecture normally returns a scroll
// action first, after which popup.js captures and sanitizes the
// new viewport again.
//
// ============================================================

function scrollElementIntoView(
    element
) {

    if (!element) {

        return {
            success: false,
            error:
                "Element not found"
        };
    }


    try {

        element.scrollIntoView(
            {
                behavior: "smooth",
                block: "center",
                inline: "center"
            }
        );


        return {
            success: true,
            action: "scroll",
            message:
                "Element scrolled into view"
        };

    } catch (error) {

        return {
            success: false,
            error:
                error.message
        };
    }
}




// ============================================================
// EXECUTE CLICK
// ============================================================

function executeClick(action) {
    console.log("[ACTION] Click request received.");

    const submitIntent =
        action?.submitIntent === true ||
        action?.target?.submitIntent === true;

    // =========================================================
    // SUBMIT INTENT
    // =========================================================
    //
    // For Submit, do not blindly trust an AI-generated
    // coordinate. Resolve the actual Submit control locally.
    //
    // This keeps the final click decision inside the browser.
    // =========================================================

    if (submitIntent) {
        console.log(
            "[SAFETY] Submit intent detected. Resolving Submit button locally."
        );

        const submitCandidates = Array.from(
    document.querySelectorAll(
        [
            'button',
            'input[type="submit"]',
            '[role="button"]'
        ].join(",")
    )
);

        let submitButton = null;

        for (const candidate of submitCandidates) {
            try {
                if (!candidate) {
                    continue;
                }

                if (!isSubmitElement(candidate)) {
                    continue;
                }
                console.log(
    "[SAFETY] Submit candidate identified:",
    candidate.tagName
);
                if (!isInteractableElement(candidate)) {
                    continue;
                }

                if (isSensitiveTarget(candidate)) {
                    console.warn(
                        "[SAFETY] Submit candidate rejected as sensitive."
                    );
                    continue;
                }

                submitButton = candidate;
                break;
            } catch (error) {
                console.warn(
                    "[SAFETY] Submit candidate check failed."
                );
            }
        }

        if (!submitButton) {
            console.warn(
                "[SAFETY] No safe Submit control found."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: no safe Submit control found."
            };
        }

        // Make sure the real Submit control is visible.
        try {
            submitButton.scrollIntoView({
                behavior: "auto",
                block: "center",
                inline: "center"
            });
        } catch (_) {
            // Ignore scroll failure; final interactability
            // check below still applies.
        }

        // Re-check after scrolling.
        if (!isInteractableElement(submitButton)) {
            console.warn(
                "[SAFETY] Submit control is not interactable."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: Submit control is not interactable."
            };
        }

        if (isSensitiveTarget(submitButton)) {
            console.warn(
                "[SAFETY] Submit control failed final sensitivity check."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: Submit control failed final safety validation."
            };
        }

        console.log(
            "[SAFETY] Safe Submit control resolved locally."
        );

        try {
            submitButton.click();

            console.log(
                "[ACTION] Submit click executed successfully."
            );

            return {
                success: true,
                action: "click",
                element: submitButton.tagName
            };
        } catch (error) {
            console.error(
                "[ACTION] Submit click failed."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Submit click execution failed."
            };
        }
    }

    // =========================================================
    // NORMAL CLICK
    // =========================================================

    const validation = validateBrowserAction(action);

    if (!validation.valid) {
        console.warn(
            "[SAFETY] Click rejected by local validation."
        );

        return {
            success: false,
            action: "click",
            error:
                validation.error ||
                "Browser action rejected by local safety policy."
        };
    }

    const clickable =
        validation.element;

    if (!clickable) {
        return {
            success: false,
            action: "click",
            error:
                "No safe clickable element found."
        };
    }

    // Final local safety check.
    if (!isInteractableElement(clickable)) {
        return {
            success: false,
            action: "click",
            error:
                "Browser action rejected: target is not interactable."
        };
    }

    if (isSensitiveTarget(clickable)) {
        return {
            success: false,
            action: "click",
            error:
                "Browser action rejected: target is sensitive."
        };
    }

    try {
        clickable.click();

        return {
            success: true,
            action: "click",
            element: clickable.tagName
        };
    } catch (error) {
        return {
            success: false,
            action: "click",
            error:
                "Click execution failed."
        };
    }
}
// ============================================================
// EXECUTE TYPE
// ============================================================
//
// Privacy model:
//
// 1. Agent receives only SAFE DOM metadata.
// 2. Value to type comes explicitly from user's task.
// 3. Existing value is NEVER sent to server.
// 4. Screenshot PII redaction happens locally.
// 5. Password / credential / OTP fields are blocked.
// 6. Normal requested fields can be edited locally.
// ============================================================

function executeType(
    target,
    value
) {

    // ========================================================
    // VALIDATE TARGET
    // ========================================================

    if (
        !target ||
        target.x == null ||
        target.y == null
    ) {

        return {

            success: false,

            error:
                "Type target coordinates missing"
        };
    }


    // ========================================================
    // VALIDATE VALUE
    // ========================================================

    if (
        value === null ||
        value === undefined ||
        String(value).length === 0
    ) {

        return {

            success: false,

            error:
                "Type value is empty"
        };
    }


    // ========================================================
    // VALIDATE VIEWPORT
    // ========================================================

    const x =
        Number(target.x);

    const y =
        Number(target.y);


    if (
        !isPointInViewport(
            x,
            y
        )
    ) {

        return {

            success: false,

            action:
                "scroll_required",

            error:
                "Type target is outside the current viewport",

            x,

            y
        };
    }


    // ========================================================
    // FIND ELEMENT AT TARGET
    // ========================================================

    const element =
        document.elementFromPoint(
            x,
            y
        );


    if (!element) {

        return {

            success: false,

            error:
                "No element found at type coordinates"
        };
    }


    // ========================================================
    // FIND EDITABLE INPUT
    // ========================================================

    const input =
        element.closest(
            "input, textarea"
        );


    if (!input) {

        return {

            success: false,

            error:
                "Target is not an input or textarea"
        };
    }


    // ========================================================
    // READ ONLY METADATA
    // ========================================================
    //
    // IMPORTANT:
    //
    // We intentionally DO NOT read input.value.
    //
    // These attributes are safe metadata used only to enforce
    // the local privacy policy.
    // ========================================================

    const inputType =
        (
            input.getAttribute(
                "type"
            ) || ""
        ).toLowerCase();


    const inputName =
        (
            input.getAttribute(
                "name"
            ) || ""
        ).toLowerCase();


    const inputId =
        (
            input.getAttribute(
                "id"
            ) || ""
        ).toLowerCase();


    const inputPlaceholder =
        (
            input.getAttribute(
                "placeholder"
            ) || ""
        ).toLowerCase();


    const autocomplete =
        (
            input.getAttribute(
                "autocomplete"
            ) || ""
        ).toLowerCase();


    const ariaLabel =
        (
            input.getAttribute(
                "aria-label"
            ) || ""
        ).toLowerCase();


    // ========================================================
    // COMBINED SAFE METADATA
    // ========================================================

    const metadata =
        [
            inputName,
            inputId,
            inputPlaceholder,
            autocomplete,
            ariaLabel
        ].join(" ");


    // ========================================================
    // HARD PRIVACY BLOCK
    // ========================================================

    const isPasswordField =
        inputType === "password";


    const isCredentialField =
        metadata.includes(
            "password"
        ) ||
        metadata.includes(
            "passwd"
        ) ||
        metadata.includes(
            "credential"
        ) ||
        metadata.includes(
            "secret"
        );


    const isOTPField =
    metadata.includes(
        "otp"
    ) ||
    metadata.includes(
        "one-time-code"
    ) ||
    metadata.includes(
        "one time code"
    ) ||
    metadata.includes(
        "one-time-password"
    ) ||
    metadata.includes(
        "verification code"
    ) ||
    autocomplete ===
        "one-time-code";


    if (
        isPasswordField ||
        isCredentialField ||
        isOTPField
    ) {

        console.warn(
            "Typing blocked on protected credential field"
        );

        return {

            success: false,

            error:
                "Typing into password, credential or OTP fields is blocked"
        };
    }


    // ========================================================
    // DISABLED / READONLY SAFETY
    // ========================================================

    if (
        input.disabled
    ) {

        return {

            success: false,

            error:
                "Target input is disabled"
        };
    }


    if (
        input.readOnly
    ) {

        return {

            success: false,

            error:
                "Target input is read-only"
        };
    }


    // ========================================================
    // LOCAL PII EDITING
    // ========================================================
    //
    // A Full Name / Email / Phone field may contain PII.
    //
    // That does NOT prevent the user from editing it.
    //
    // Existing field value remains inside the browser.
    //
    // We never send input.value to backend.
    // ========================================================

    console.log(
        "ðŸ” Local editable field:",
        {
            tag:
                input.tagName,

            type:
                inputType ||
                "text",

            name:
                inputName,

            id:
                inputId,

            placeholder:
                inputPlaceholder
        }
    );


    // ========================================================
    // FOCUS INPUT
    // ========================================================

    input.focus();


    // ========================================================
    // SET VALUE
    // ========================================================

    input.value =
        String(value);


    // ========================================================
    // TRIGGER INPUT EVENT
    // ========================================================

    input.dispatchEvent(
        new Event(
            "input",
            {
                bubbles: true
            }
        )
    );


    // ========================================================
    // TRIGGER CHANGE EVENT
    // ========================================================

    input.dispatchEvent(
        new Event(
            "change",
            {
                bubbles: true
            }
        )
    );


    // ========================================================
    // FINAL RESULT
    // ========================================================

    console.log(
        "Safe local value entered"
    );


    return {

        success: true,

        action:
            "type",

        element:
            input.tagName,

        message:
            "Safe value entered locally"
    };
}


// ============================================================
// EXECUTE SCROLL
// ============================================================
//
// The planner can return:
//
// {
//     action: "scroll",
//     amount: 600
// }
//
// After this action succeeds, popup.js performs another
// capture + local sanitization + AI planning cycle.
//
// ============================================================

function executeScroll(
    value
) {

    const validation =
        validateScrollAmount(
            value
        );


    if (
        !validation.valid
    ) {

        return {

            success: false,

            action:
                "scroll_blocked",

            error:
                validation.error
        };
    }


    const amount =
        validation.amount;


    try {

        window.scrollBy({

            top:
                amount,

            left:
                0,

            behavior:
                "smooth"
        });

    } catch (error) {

        return {

            success: false,

            action:
                "scroll",

            retryable: true,

            error:
                "Scroll execution failed"
        };
    }


    return {

        success: true,

        action:
            "scroll",

        amount
    };
}


// ============================================================
// EXECUTE WAIT
// ============================================================

function executeWait(
    value
) {

    const validation =
        validateWaitDuration(
            value
        );


    if (
        !validation.valid
    ) {

        return {

            success: false,

            action:
                "wait_blocked",

            error:
                validation.error
        };
    }


    return {

        success: true,

        action:
            "wait",

        delay:
            validation.milliseconds
    };
}

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================
//
// The planner is untrusted.
//
// Every action passes through:
//     1. Local safety validation
//     2. Action-specific executor
//     3. Executor-level validation
//
// Fail closed on anything unexpected.
// ============================================================

function executeBrowserAction(
    action
) {

    // --------------------------------------------------------
    // GLOBAL ACTION SAFETY GATE
    // --------------------------------------------------------

    const validation =
        validateBrowserAction(
            action
        );

    if (
        !validation.valid
    ) {

        console.warn(
            "[SAFETY] Browser action blocked:",
            validation.error
        );

        if (
            validation.requiresScroll
        ) {

            return {
                success: false,

                action:
                    "scroll_required",

                error:
                    validation.error,

                x:
                    validation.x,

                y:
                    validation.y,

                retryable:
                    true
            };
        }

        return {
    success: false,

    action:
        validation.action ||
        "action_blocked",

    retryable:
        validation.retryable === true,

    unsafe:
        validation.unsafe === true,

    error:
        validation.error ||
        "Browser action rejected by local safety policy"
};
    }


    // --------------------------------------------------------
    // NORMALIZED ACTION TYPE
    // --------------------------------------------------------

    const actionType =
        validation.action;


    // --------------------------------------------------------
    // NONE
    // --------------------------------------------------------

    if (
        actionType === "none"
    ) {

        return {
            success: true,

            action:
                "none"
        };
    }


    // --------------------------------------------------------
    // CLICK
    // --------------------------------------------------------

    if (
        actionType === "click"
    ) {

        const target = {
    x:
        action?.target?.x !== undefined
            ? action.target.x
            : action?.x,

    y:
        action?.target?.y !== undefined
            ? action.target.y
            : action?.y,

    submitIntent:
        action?.submitIntent === true ||
        action?.target?.submitIntent === true
};

return executeClick(
    target
);
    }


    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    if (
        actionType === "type"
    ) {

        const target =
            action?.target ||
            {
                x:
                    action?.x,

                y:
                    action?.y
            };

        const value =
            action?.value !== undefined
                ? action.value
                : action?.text;

        return executeType(
            target,
            value
        );
    }


    // --------------------------------------------------------
    // SCROLL
    // --------------------------------------------------------

    if (
        actionType === "scroll"
    ) {

        const amount =
            action?.amount !== undefined
                ? action.amount
                : action?.value;

        return executeScroll(
            amount
        );
    }


    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    if (
        actionType === "wait"
    ) {

        const duration =
            action?.amount !== undefined
                ? action.amount
                : action?.value;

        return executeWait(
            duration
        );
    }


    // --------------------------------------------------------
    // FAIL CLOSED
    // --------------------------------------------------------

    return {
        success: false,

        action:
            "action_blocked",

        unsafe: true,

        error:
            "Browser action failed closed"
    };
}
// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {


        // ====================================================
        // GET BENCHMARK METRICS
        // ====================================================

        if (
            message?.type ===
            "GET_BENCHMARK_METRICS"
        ) {

            sendResponse({
                success: true,
                metrics:
                    getBenchmarkSnapshot()
            });


            return true;
        }


        // ====================================================
        // RUN OCR BENCHMARK
        // ====================================================
        //
        // PHASE 2.7:
        //
        // This handler exists ONLY to let the benchmark page
        // (pii-accuracy-test.html, via background.js) measure
        // OCR accuracy/performance.
        //
        // It is intentionally isolated from the production
        // capture pipeline:
        //
        //   - It never calls runPrivacyEngine(), fusion, or
        //     sanitizeScreenshot().
        //   - It never triggers EXECUTE_ACTION or any browser
        //     automation.
        //   - It reuses window.SIHOCR.testScreenshot() as-is;
        //     no second OCR metrics engine is created here.
        //   - Raw OCR text stays inside ocr.js. Only
        //     type/confidence/uncertain metadata and the
        //     existing ocrBenchmark report leave this function.
        //
        // ====================================================

        if (
            message?.type ===
            "RUN_OCR_BENCHMARK"
        ) {

            // ------------------------------------------------
            // VALIDATE PAYLOAD
            // ------------------------------------------------

            const screenshot =
                message?.screenshot;

            if (
                typeof screenshot !== "string" ||
                screenshot.length === 0
            ) {

                sendResponse({

                    success:
                        false,

                    error:
                        "OCR benchmark request is missing a screenshot.",

                    code:
                        "INVALID_BENCHMARK_REQUEST"
                });

                return false;
            }


            if (
                !window.SIHOCR ||
                typeof window.SIHOCR.testScreenshot !==
                    "function"
            ) {

                console.warn(
                    "[OCR-BENCH] SIHOCR is not available on this page."
                );

                sendResponse({

                    success:
                        false,

                    error:
                        "OCR module is not available on this page.",

                    code:
                        "OCR_BENCHMARK_FAILED"
                });

                return false;
            }


            // ------------------------------------------------
            // STATE ISOLATION
            // ------------------------------------------------
            //
            // Never let a benchmark run overlap with either
            // another benchmark run or a production capture,
            // and never let it appear as a production capture
            // to the rest of the content script.
            //
            // ------------------------------------------------

            if (
                ocrBenchmarkInProgress ||
                captureInProgress
            ) {

                console.warn(
                    "[OCR-BENCH] A capture or benchmark run is already in progress."
                );

                sendResponse({

                    success:
                        false,

                    error:
                        "A capture or OCR benchmark is already running. Please wait.",

                    code:
                        "OCR_BENCHMARK_FAILED",

                    retryable:
                        true
                });

                return false;
            }

            ocrBenchmarkInProgress = true;


            if (message.resetBenchmark === true) {

                window.SIHOCR.resetBenchmark();
            }


            // ------------------------------------------------
            // TIMEOUT PROTECTION
            // ------------------------------------------------
            //
            // OCR is CPU-heavy. A stuck Tesseract run must
            // never hang the benchmark page or the extension
            // message channel forever.
            //
            // ------------------------------------------------

            const OCR_BENCH_TIMEOUT_MS = 12000;

            const timeoutPromise =
                new Promise(
                    (_, reject) =>
                        setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        "OCR benchmark timed out."
                                    )
                                ),
                            OCR_BENCH_TIMEOUT_MS
                        )
                );


            Promise.race([

                window.SIHOCR.testScreenshot(
                    screenshot
                ),

                timeoutPromise

            ])

                .then(
                    function (ocrResult) {

                        // ------------------------------
                        // IMPORTANT PRIVACY RULE
                        // ------------------------------
                        //
                        // OCR text (ocrResult.text,
                        // ocrResult.words) stays inside
                        // this content script. Only
                        // classification-level metadata
                        // and aggregate metrics leave
                        // this handler.
                        // ------------------------------

                        const metrics =
                            typeof window.SIHOCR.getMetrics ===
                                "function"
                                ? window.SIHOCR.getMetrics()
                                : {};

                        const report =
                            typeof window.SIHOCR.getBenchmarkReport ===
                                "function"
                                ? window.SIHOCR.getBenchmarkReport()
                                : null;

                        const safeDetections =
                            (
                                Array.isArray(
                                    ocrResult?.detections
                                )
                                    ? ocrResult.detections
                                    : []
                            )
                                .map(
                                    function (detection) {

                                        return {

                                            type:
                                                String(
                                                    detection?.type ||
                                                    ""
                                                ).toUpperCase(),

                                            confidence:
                                                Number(
                                                    detection?.confidence
                                                ) || 0,

                                            uncertain:
                                                Boolean(
                                                    detection?.uncertain
                                                ),

                                            detected:
                                                detection?.redactionRecommended !==
                                                    false
                                        };
                                    }
                                );

                        const acceptedPII =
                            Number(
                                ocrResult?.confidenceFiltering
                                    ?.accepted
                            ) || 0;

                        const rejectedPII =
                            Number(
                                ocrResult?.confidenceFiltering
                                    ?.rejected
                            ) || 0;


                        console.log(
                            "[OCR-BENCH]",
                            `run=${metrics.runs || 0}`,
                            `words=${ocrResult.wordCount || 0}`,
                            `pii=${safeDetections.length}`,
                            `accepted=${acceptedPII}`,
                            `rejected=${rejectedPII}`,
                            `latency=${Number(
                                ocrResult.latencyMs || 0
                            ).toFixed(2)}ms`,
                            `confidence=${Number(
                                metrics.lastAverageConfidence || 0
                            ).toFixed(2)}`
                        );


                        ocrBenchmarkInProgress = false;


                        sendResponse({

                            success:
                                true,

                            ocr: {

                                latencyMs:
                                    Number(
                                        ocrResult.latencyMs
                                    ) || 0,

                                totalWords:
                                    Number(
                                        ocrResult.wordCount
                                    ) || 0,

                                piiDetections:
                                    safeDetections.length,

                                acceptedPII,

                                rejectedPII,

                                averageConfidence:
                                    Number(
                                        metrics.lastAverageConfidence
                                    ) || 0,

                                minConfidence:
                                    Number(
                                        metrics.lastMinConfidence
                                    ) || 0,

                                detections:
                                    safeDetections
                            },

                            // Also surfaced at the top level so
                            // background.js's existing benchmark
                            // sanitizer (which reads
                            // response.detections / response.report)
                            // keeps working unchanged.
                            detections:
                                safeDetections,

                            report
                        });
                    }
                )

                .catch(
                    function (error) {

                        const isTimeout =
                            String(
                                error?.message || ""
                            ).includes("timed out");

                        console.error(
                            "[OCR-BENCH] Benchmark run failed:",
                            error?.message ||
                            error
                        );


                        ocrBenchmarkInProgress = false;


                        sendResponse({

                            success:
                                false,

                            error:
                                error?.message ||
                                "OCR benchmark failed.",

                            code:
                                isTimeout
                                    ? "OCR_TIMEOUT"
                                    : "OCR_BENCHMARK_FAILED",

                            retryable:
                                isTimeout
                        });
                    }
                );


            // Keep the message channel open for the
            // asynchronous response.

            return true;
        }


        // ====================================================
        // PREPARE CAPTURE
        // ====================================================

        if (
            message.type ===
            "PREPARE_CAPTURE"
        ) {

            runPrivacyEngine();


            const currentDetections =
                getSerializableDetections();


            const safeDOM =
                collectSafeDOM();


            /*
             * Never leave visible privacy overlays on the page.
             */

            removePrivacyOverlays();


            console.log(
                "ðŸ“ Capture prepared with",
                currentDetections.length,
                "PII regions"
            );


            sendResponse({

                success: true,

                detections:
                    currentDetections,

                dom_elements:
                    safeDOM,

                viewport: {

                    width:
                        window.innerWidth,

                    height:
                        window.innerHeight,

                    devicePixelRatio:
                        window.devicePixelRatio,

                    scrollX:
                        window.scrollX,

                    scrollY:
                        window.scrollY,

                    documentWidth:
                        document.documentElement
                            ? document.documentElement.scrollWidth
                            : window.innerWidth,

                    documentHeight:
                        document.documentElement
                            ? document.documentElement.scrollHeight
                            : window.innerHeight
                }
            });


            return true;
        }


        // ====================================================
        // SANITIZE SCREENSHOT
        // ====================================================
        //
        // PHASE 3:
        // OCR and Face Detection run independently and in
        // parallel. Both must succeed before fusion/redaction
        // runs; either failing blocks transmission.
        //
        //     OCR â”€â”€â”€â”€â”€â”€â”
        //               â”œâ”€â”€â†’ FUSION â†’ REDACTION
        //     FACE â”€â”€â”€â”€â”€â”˜
        //
        // IMPORTANT:
        // OCR text and raw face imagery NEVER leave the content
        // script. The backend receives only the already-
        // sanitized image.
        // ====================================================

if (
    message.type ===
    "SANITIZE_SCREENSHOT"
) {

    if (captureInProgress) {
        console.warn(
            "[PRIVACY] Capture already in progress. Rejecting duplicate request."
        );

        sendResponse({
            success: false,
            error: "Capture already in progress. Please wait."
        });

        return true;
    }

    resetBenchmarkMetrics();

    captureInProgress = true;

    if (
        typeof message.screenshot !== "string" ||
        !message.screenshot.startsWith(
            "data:image/"
        )
    ) {

        captureInProgress = false;

        sendResponse({
            success: false,
            error:
                "Privacy pipeline blocked: invalid screenshot."
        });

        return true;
    }

    captureGeneration += 1;

    const currentCaptureGeneration =
        captureGeneration;

    const screenshotPipelineStart =
        performance.now();


    // ====================================================
    // EARLY FAIL-CLOSED GUARD â€” OCR MODULE
    // ====================================================
    //
    // If OCR is unavailable, block immediately instead of
    // starting Face Detection and then discarding it.
    // There is no unsanitized-screenshot fallback.
    // ====================================================

    if (
        !window.SIHOCR ||
        typeof window.SIHOCR.testScreenshot !== "function"
    ) {

        console.error(
            "[PRIVACY] OCR module unavailable."
        );

        captureInProgress = false;

        sendResponse({
            success: false,
            error:
                "Privacy pipeline blocked: OCR module unavailable."
        });

        return true;
    }


    // ====================================================
    // PHASE 2.2 â€” LOCAL OCR (independent stage)
    // ====================================================

    async function runOCRStage() {

        const runOCR =
            window.SIHOCR &&
            typeof window.SIHOCR.testScreenshot ===
                "function";

        if (!runOCR) {

            console.error(
                "[PRIVACY] OCR module unavailable."
            );

            throw new Error(
                "Privacy pipeline blocked: OCR module unavailable."
            );
        }

        console.log(
            "[OCR] Running local OCR on captured screenshot..."
        );

        const ocrResult =
            await window.SIHOCR.testScreenshot(
                message.screenshot
            );

        // ----------------------------------------
        // IMPORTANT PRIVACY RULE
        // ----------------------------------------
        //
        // OCR text remains inside this content
        // script.
        //
        // Do NOT place ocrResult.text inside
        // sendResponse().
        //
        // Do NOT send it through chrome.runtime.
        // ----------------------------------------

        console.log(
            "[OCR] Local screenshot OCR completed:",
            `${ocrResult.latencyMs.toFixed(2)} ms`,
            `| words=${ocrResult.words.length}`
        );

        console.log(
            "[OCR] Bounding boxes available:",
            ocrResult.words.length
        );

        return ocrResult;
    }


    // ====================================================
    // PHASE 3 â€” LOCAL FACE DETECTION (independent stage)
    // ====================================================
    //
    // The raw screenshot remains inside content.js.
    // No image/frame is sent to the backend.
    // Only sanitized face metadata is retained.
    // ====================================================

    async function runFaceStage() {

        const faceStart =
            performance.now();

        benchmarkMetrics.faceDetectionFailed =
            false;

        benchmarkMetrics.faceDetectionAvailable =
            Boolean(
                window.SIHFace &&
                typeof window.SIHFace.detect === "function"
            );

        if (
            !benchmarkMetrics.faceDetectionAvailable
        ) {

            benchmarkMetrics.faceDetectionFailed =
                true;

            console.error(
                "[FACE] Face detector unavailable."
            );

            throw new Error(
                "Privacy pipeline blocked: face detector unavailable."
            );
        }

        try {

            console.log(
                "[FACE] Running local face detection..."
            );

            const faceTimeout =
                new Promise(
                    function (_, reject) {

                        setTimeout(
                            function () {

                                reject(
                                    new Error(
                                        "Face detection timed out."
                                    )
                                );

                            },
                            FACE_DETECTION_TIMEOUT_MS
                        );
                    }
                );

            const faceResult =
                await Promise.race([
                    window.SIHFace.detect({
                        screenshot:
                            message.screenshot
                    }),
                    faceTimeout
                ]);

            const rawFaceDetections =
                Array.isArray(faceResult)
                    ? faceResult
                    : Array.isArray(
                        faceResult?.detections
                    )
                        ? faceResult.detections
                        : [];

            benchmarkMetrics.faceDetectionsBeforeFilter =
                rawFaceDetections.length;

            const faceDetections =
                normalizeFaceDetections(
                    faceResult
                );

            benchmarkMetrics.faceDetectionsRejected =
                Math.max(
                    0,
                    rawFaceDetections.length -
                    faceDetections.length
                );

            benchmarkMetrics.faceDetectionCount =
                faceDetections.length;

            if (
                faceDetections.length > 0
            ) {

                const confidenceSum =
                    faceDetections.reduce(
                        function (sum, detection) {

                            return (
                                sum +
                                Number(
                                    detection.confidence
                                )
                            );
                        },
                        0
                    );

                benchmarkMetrics.faceAverageConfidence =
                    confidenceSum /
                    faceDetections.length;
            }

            benchmarkMetrics.faceDetectionLatencyMs =
                performance.now() -
                faceStart;

            console.log(
                "[FACE] Completed:",
                `faces=${faceDetections.length}`,
                `latency=${benchmarkMetrics.faceDetectionLatencyMs.toFixed(2)} ms`
            );

            if (
                faceDetections.length === 0
            ) {

                console.log(
                    "[FACE] No faces detected."
                );
            }

            return faceDetections;

        } catch (error) {

            benchmarkMetrics.faceDetectionFailed =
                true;

            benchmarkMetrics.faceDetectionLatencyMs =
                performance.now() -
                faceStart;

            console.error(
                "[FACE] Detection failed:",
                error?.message ||
                error
            );

            /*
             * Fail closed.
             *
             * A face detector failure must not silently
             * become a successful privacy result.
             */

            throw new Error(
                "Privacy pipeline blocked: face detection failed."
            );
        }
    }


    // ====================================================
    // FUSION + REDACTION (runs once OCR and FACE both settle)
    // ====================================================

    async function runPrivacyPipeline() {

        const [
            ocrSettled,
            faceSettled
        ] = await Promise.allSettled([
            runOCRStage(),
            runFaceStage()
        ]);

        if (
            ocrSettled.status === "rejected"
        ) {

            throw ocrSettled.reason;
        }

        if (
            faceSettled.status === "rejected"
        ) {

            throw faceSettled.reason;
        }

        const ocrResult =
            ocrSettled.value;

        const faceDetections =
            faceSettled.value;

        // ----------------------------------------
        // PHASE 2.4 â€” MULTI-SOURCE PII FUSION
        // ----------------------------------------
        //
        // DOM detections and OCR detections are
        // independently generated.
        //
        // DOM detections:
        //     message.detections
        //
        // OCR detections:
        //     ocrResult.detections
        //
        // Fusion combines overlapping detections,
        // removes duplicates and preserves
        // OCR-only detections.
        //
        // IMPORTANT:
        // Actual PII values never enter this layer.
        // Only:
        //     type
        //     source
        //     confidence
        //     rect
        //
        // are used.
        // ----------------------------------------

        const domDetections = (message.detections || []).map(function (detection) {
            return {
                ...detection,
                source: "dom"
            };
        });

        const ocrDetections = (ocrResult.detections || []).map(function (detection) {
            return {
                ...detection,
                source: "ocr"
            };
        });

        benchmarkMetrics.domDetectionCount =
            domDetections.length;

        benchmarkMetrics.ocrDetectionCount =
            ocrDetections.length;

        const visionDetections =
            (faceDetections || []).map(
                function (detection) {

                    return {

                        ...detection,

                        type: "FACE",

                        source: "vision"

                    };

                }
            );

        console.log(
            "[FUSION] Input detections:",
            `DOM=${domDetections.length}`,
            `OCR=${ocrDetections.length}`,
            `FACE=${visionDetections.length}`
        );


        // ----------------------------------------
        // FACE CONFIDENCE VALIDATION
        // ----------------------------------------
        //
        // normalizeFaceDetections() already filters by
        // FACE_CONFIDENCE_THRESHOLD; this is a final
        // defense-in-depth safety check.
        // ----------------------------------------

        const invalidFaceDetection =
            faceDetections.some(
                function (detection) {

                    const confidence =
                        Number(
                            detection.confidence
                        );

                    return (
                        !Number.isFinite(
                            confidence
                        ) ||
                        confidence <
                            FACE_CONFIDENCE_THRESHOLD ||
                        confidence > 1
                    );
                }
            );

        if (
            invalidFaceDetection
        ) {

            throw new Error(
                "Privacy pipeline blocked: invalid face confidence."
            );
        }


        // ----------------------------------------
        // RUN FUSION
        // ----------------------------------------

        let fusedDetections = [
            ...domDetections,
            ...ocrDetections,
            ...visionDetections
        ];

        const fusionStart =
            performance.now();

        benchmarkMetrics.fusionInputRegions =
            fusedDetections.length;

        if (
            window.SIHPiiFusion &&
            typeof window.SIHPiiFusion.fuse ===
                "function"
        ) {

            const fusionInput = [
                ...domDetections,
                ...ocrDetections,
                ...visionDetections
            ];

            const fusionResult =
                window.SIHPiiFusion.fuse([
                    ...domDetections,
                    ...ocrDetections,
                    ...visionDetections
                ]);

            fusedDetections =
                Array.isArray(
                    fusionResult?.detections
                )
                    ? fusionResult.detections
                    : fusedDetections;

            benchmarkMetrics.fusionLatencyMs =
                performance.now() -
                fusionStart;

            benchmarkMetrics.fusionOutputRegions =
                fusedDetections.length;


            console.log(
                "[FUSION] Unified PII set:",
                `input=${fusionResult?.stats?.input ?? fusionInput.length}`,
                `output=${fusionResult?.stats?.output ?? fusedDetections.length}`,
                `merged=${fusionResult?.stats?.merged ?? 0}`,
                `DOM=${fusionResult?.stats?.dom ?? domDetections.length}`,
                `OCR=${fusionResult?.stats?.ocr ?? ocrDetections.length}`,
                `latency=${Number(
                    fusionResult?.latencyMs || 0
                ).toFixed(2)} ms`
            );

        } else {

            console.error(
                "[FUSION] Fusion module unavailable."
            );

            throw new Error(
                "Privacy pipeline blocked: fusion module unavailable."
            );
        }


        // ----------------------------------------
        // SAFETY CHECK
        // ----------------------------------------
        //
        // Every detection reaching the redaction
        // engine must have valid geometry.
        //
        // If fusion somehow returns an invalid
        // detection, fail closed instead of
        // silently allowing it through.
        // ----------------------------------------

        const invalidFusedDetection =
            fusedDetections.some(
                detection =>
                    !detection ||
                    !isValidDetectionRect(
                        detection.rect
                    )
            );


        if (
            invalidFusedDetection
        ) {

            throw new Error(
                "Privacy pipeline blocked: invalid fused detection geometry."
            );
        }


        console.log(
            "ðŸ“ Sanitizing screenshot with",
            fusedDetections.length,
            "unified PII regions"
        );


        // ----------------------------------------
        // LOCAL REDACTION
        // ----------------------------------------

        const sanitizedImage =
            await sanitizeScreenshot(

                message.screenshot,

                fusedDetections

            );

        console.log(
            "[FACE] Redaction pipeline:",
            `detected=${faceDetections.length}`,
            `verified=${benchmarkMetrics.verificationPassed === true}`
        );


        // ----------------------------------------
        // STALE-CAPTURE PROTECTION
        // ----------------------------------------
        //
        // Now that OCR and FACE run independently,
        // an old asynchronous result must never be
        // allowed to satisfy a newer capture request.
        // ----------------------------------------

        if (
            currentCaptureGeneration !==
            captureGeneration
        ) {

            throw new Error(
                "Privacy pipeline blocked: stale capture result."
            );
        }

        return sanitizedImage;
    }


    // ====================================================
    // COMPLETE PIPELINE TIMEOUT
    // ====================================================
    //
    // Prevents: captureInProgress = true â†’ something hangs â†’
    // capture never finishes.
    // ====================================================

    const pipelineTimeout =
        new Promise(
            function (_, reject) {

                setTimeout(
                    function () {

                        reject(
                            new Error(
                                "Privacy screenshot pipeline timed out."
                            )
                        );

                    },
                    SCREENSHOT_PIPELINE_TIMEOUT_MS
                );
            }
        );

    Promise.race([
        runPrivacyPipeline(),
        pipelineTimeout
    ])
        .then(function (sanitizedImage) {

            benchmarkMetrics.screenshotPipelineLatencyMs =
                performance.now() -
                screenshotPipelineStart;

            logPrivacyPipelineSummary();

            sendResponse({

                success: true,

                sanitizedImage,

                dom_elements:
                    collectSafeDOM(),

                viewport: {

                    width:
                        window.innerWidth,

                    height:
                        window.innerHeight,

                    devicePixelRatio:
                        window.devicePixelRatio,

                    scrollX:
                        window.scrollX,

                    scrollY:
                        window.scrollY,

                    documentWidth:
                        document.documentElement
                            ? document.documentElement.scrollWidth
                            : window.innerWidth,

                    documentHeight:
                        document.documentElement
                            ? document.documentElement.scrollHeight
                            : window.innerHeight

                }

            });

        })
        .catch(function (error) {

            console.error(
                "[PRIVACY] Screenshot sanitization pipeline failed:",
                error?.message ||
                error
            );

            sendResponse({

                success: false,

                error:
                    error?.message ||
                    "Privacy screenshot sanitization failed."

            });

        })
        .finally(function () {

            captureInProgress =
                false;

            runPrivacyEngine();

        });


    return true;
}
                


        // ====================================================
        // EXECUTE ACTION
        // ====================================================

        if (
            message.type ===
            "EXECUTE_ACTION"
        ) {

            const actionStart =
                performance.now();

            const result =
                executeBrowserAction(
                    message.action
                );

            benchmarkMetrics.actionExecutionLatencyMs =
                performance.now() -
                actionStart;

            console.log(
                "[BENCHMARK] Action execution latency:",
                benchmarkMetrics.actionExecutionLatencyMs.toFixed(2),
                "ms"
            );


            console.log(
    "[ACTION] Execution completed:",
    {
        success:
            result?.success === true,

        action:
            result?.action ||
            "unknown"
    }
);


            sendResponse(
                result
            );


            return true;
        }


        // ====================================================
        // SCROLL TO TARGET
        // ====================================================
        //
        // Optional direct DOM-target scrolling.
        //
        // The planner normally uses a regular scroll action,
        // but this message provides a safe local helper for
        // future target-aware scrolling.
        //
        // It accepts:
        //
        // {
        //     selector: "...",
        //     targetText: "Submit"
        // }
        //
        // No input values are read.
        // ====================================================

        if (
            message.type ===
            "SCROLL_TO_TARGET"
        ) {

            let targetElement =
                null;


            if (
                message.selector
            ) {

                try {

                    targetElement =
                        document.querySelector(
                            message.selector
                        );

                } catch (_) {

                    targetElement =
                        null;
                }
            }


            if (
                !targetElement &&
                message.targetText
            ) {

                const requestedText =
                    normalizeText(
                        message.targetText
                    ).toLowerCase();


                const possibleElements =
                    document.querySelectorAll(
                        "button, a, input, textarea, [role='button'], [role='link']"
                    );


                for (
                    const element
                    of possibleElements
                ) {

                    if (
                        !isVisible(element)
                    ) {
                        continue;
                    }


                    const tag =
                        element.tagName
                            .toLowerCase();


                    const type =
                        (
                            element.getAttribute(
                                "type"
                            ) || ""
                        ).toLowerCase();


                    let text =
                        normalizeText(
                            element.innerText ||
                            element.textContent ||
                            ""
                        );


                    if (
                        tag === "input" &&
                        (
                            type === "submit" ||
                            type === "button" ||
                            type === "reset"
                        )
                    ) {

                        text =
                            normalizeText(
                                element.getAttribute(
                                    "value"
                                ) || ""
                            );
                    }


                    if (
                        text
                            .toLowerCase()
                            .includes(
                                requestedText
                            )
                    ) {

                        targetElement =
                            element;

                        break;
                    }
                }
            }


            if (!targetElement) {

                sendResponse({

                    success: false,

                    error:
                        "Target element not found"
                });

                return true;
            }


            const result =
                scrollElementIntoView(
                    targetElement
                );


            sendResponse(
                result
            );


            return true;
        }
    }
);


// ============================================================
// SCROLL EVENT
// ============================================================

window.addEventListener(
    "scroll",
    () => {

        updateAllOverlayPositions();

    },
    {
        passive: true
    }
);


// ============================================================
// RESIZE EVENT
// ============================================================

window.addEventListener(
    "resize",
    () => {

        updateAllOverlayPositions();

    }
);


// ============================================================
// INPUT EVENT
// ============================================================
//
// Re-run local PII detection after user edits a field.
//
// Existing values remain local.
// ============================================================

document.addEventListener(
    "input",
    () => {

        clearTimeout(
            window.__sihPrivacyTimer
        );


        window.__sihPrivacyTimer =
            setTimeout(
                () => {

                    runPrivacyEngine();

                },
                SIH_CONFIG.inputDelay
            );
    },
    true
);


// ============================================================
// CHANGE EVENT
// ============================================================

document.addEventListener(
    "change",
    () => {

        clearTimeout(
            window.__sihPrivacyChangeTimer
        );


        window.__sihPrivacyChangeTimer =
            setTimeout(
                () => {

                    runPrivacyEngine();

                },
                SIH_CONFIG.inputDelay
            );
    },
    true
);


// ============================================================
// MUTATION OBSERVER
// ============================================================

const privacyObserver =
    new MutationObserver(
        mutations => {

            let relevant =
                false;


            for (
                const mutation
                of mutations
            ) {

                for (
                    const node
                    of mutation.addedNodes
                ) {

                    if (
                        node.nodeType !==
                        1
                    ) {
                        continue;
                    }


                    /*
                     * Ignore our own privacy overlays.
                     */

                    if (
                        node.matches &&
                        node.matches(
                            "[data-sih-privacy-overlay='true']"
                        )
                    ) {

                        continue;
                    }


                    if (
                        node.closest &&
                        node.closest(
                            "[data-sih-privacy-overlay='true']"
                        )
                    ) {

                        continue;
                    }


                    relevant =
                        true;

                    break;
                }


                if (
                    relevant
                ) {
                    break;
                }
            }


            if (
                !relevant
            ) {
                return;
            }


            clearTimeout(
                window.__sihMutationTimer
            );


            window.__sihMutationTimer =
                setTimeout(
                    () => {

                        runPrivacyEngine();

                    },
                    SIH_CONFIG.mutationDelay
                );
        }
    );


privacyObserver.observe(
    document.documentElement,
    {
        childList:
            true,

        subtree:
            true
    }
);


// ============================================================
// INITIALIZATION
// ============================================================

function initializePrivacyAgent() {

    runPrivacyEngine();

    removePrivacyOverlays();


    console.log(
        "SIH Privacy Engine initialized"
    );

    console.log(
        "Screenshot-only PII masking active"
    );

    console.log(
        "Off-screen DOM perception enabled"
    );
}


// ============================================================
// DOM READY
// ============================================================

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializePrivacyAgent,
        {
            once:
                true
        }
    );

} else {

    initializePrivacyAgent();
}