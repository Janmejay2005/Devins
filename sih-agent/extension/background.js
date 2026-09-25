// ============================================================
// SIH PRIVACY BROWSER AGENT
// background.js
// ============================================================
//
// SECURITY BOUNDARY
//
// This service worker sits between:
//     AI planner
//         |
//         v
//     background.js
//         |
//         v
//     content.js
//         |
//         v
//     browser
//
// The planner is treated as UNTRUSTED input.
//
// background.js therefore:
//
// - validates planner actions
// - removes unnecessary planner fields
// - never logs TYPE values
// - never forwards unsupported actions
// - validates content-script responses
// - applies a second PII metadata boundary
// - strips sensitive URL components
// - keeps raw screenshots inside the extension
//
// ============================================================


console.log(
    "[SIH] Privacy Agent background service started"
);


// ============================================================
// CONSTANTS
// ============================================================

const ALLOWED_ACTIONS = new Set([
    "click",
    "type",
    "scroll",
    "wait",
    "none"
]);


// Maximum scroll amount allowed in one planner action.
const MAX_SCROLL_AMOUNT = 1500;


// Maximum wait requested by one planner action.
const MAX_WAIT_MS = 5000;


// Minimum wait so a wait action cannot become an
// accidental zero-duration operation.
const MIN_WAIT_MS = 100;


// Maximum time allowed for an OCR benchmark round trip
// (background -> content.js -> ocr.js -> background).
const OCR_BENCHMARK_TIMEOUT_MS = 15000;


// Allowed PII types the OCR benchmark is permitted to
// request/report on. Keeps the benchmark route aligned
// with what ocr.js actually detects (no name detection).
const ALLOWED_BENCHMARK_TYPES = new Set([
    "EMAIL",
    "PHONE",
    "AADHAAR",
    "PAN",
    "CREDIT_CARD",
    "PASSWORD"
]);


// ============================================================
// MESSAGE SENDER VALIDATION
// ============================================================
//
// Only messages originating from this extension are accepted.
//
// This prevents an unexpected extension context from attempting
// to invoke browser actions through this service worker.
//
// ============================================================

function isTrustedExtensionSender(sender) {

    if (
        !sender ||
        !sender.id
    ) {
        return false;
    }

    return (
        sender.id === chrome.runtime.id
    );
}


// ============================================================
// SANITIZE DETECTION METADATA
// ============================================================
//
// Defense-in-depth.
//
// content.js already removes PII values from serializable
// detection metadata.
//
// background.js performs the same boundary again.
//
// IMPORTANT:
//
// detection.value
// detection.text
// detection.rawValue
//
// and similar fields are NEVER copied.
//
// Only non-sensitive classification + geometry is retained.
//
// ============================================================

function sanitizeDetectionMetadata(
    detections
) {

    if (
        !Array.isArray(detections)
    ) {
        return [];
    }


    return detections
        .map(
            (
                detection
            ) => {

                if (
                    !detection ||
                    typeof detection !== "object" ||
                    Array.isArray(detection)
                ) {
                    return null;
                }


                const sourceRect =
                    detection.rect;


                let rect = null;


                if (
                    sourceRect &&
                    typeof sourceRect === "object"
                ) {

                    const left =
                        Number(
                            sourceRect.left
                        );

                    const top =
                        Number(
                            sourceRect.top
                        );

                    const right =
                        Number(
                            sourceRect.right
                        );

                    const bottom =
                        Number(
                            sourceRect.bottom
                        );

                    const width =
                        Number(
                            sourceRect.width
                        );

                    const height =
                        Number(
                            sourceRect.height
                        );


                    if (
                        [
                            left,
                            top,
                            right,
                            bottom,
                            width,
                            height
                        ]
                            .every(
                                Number.isFinite
                            )
                    ) {

                        rect = {
                            left,
                            top,
                            right,
                            bottom,
                            width,
                            height
                        };
                    }
                }


                return {
                    id:
                        String(
                            detection.id || ""
                        ),

                    type:
                        String(
                            detection.type || ""
                        ),

                    source:
                        String(
                            detection.source || ""
                        ),

                    tagName:
                        String(
                            detection.tagName || ""
                        ),

                    rect
                };
            }
        )
        .filter(
            Boolean
        );
}


// ============================================================
// PRIVACY-SAFE ACTION LOGGING
// ============================================================
//
// NEVER log the complete planner action.
//
// TYPE actions may contain:
//
//     text: "Amit Kumar"
//
// or potentially sensitive text.
//
// Only action metadata is logged.
//
// ============================================================

function getSafeActionLog(
    action
) {

    if (
        !action ||
        typeof action !== "object"
    ) {

        return {
            action: "none"
        };
    }


    const actionType =
        String(
            action.action ||
            action.type ||
            "none"
        )
            .toLowerCase()
            .trim();


    const rawConfidence =
        Number(
            action.confidence
        );


    const confidence =
        Number.isFinite(
            rawConfidence
        )
            ? Math.min(
                1,
                Math.max(
                    0,
                    rawConfidence
                )
            )
            : 0;


    const safe = {
        action:
            actionType,

        confidence
    };


    if (
    actionType === "click"
) {
    safe.target = {
        x:
            Number(
                action.x ??
                action.target?.x ??
                0
            ),

        y:
            Number(
                action.y ??
                action.target?.y ??
                0
            ),

        submitIntent:
            action?.submitIntent === true ||
            action?.target?.submitIntent === true
    };
}


    if (
        actionType === "type"
    ) {

        safe.valueLength =
            String(
                action.text ??
                action.value ??
                ""
            ).length;
    }


    if (
        actionType === "scroll" ||
        actionType === "wait"
    ) {

        safe.amount =
            Number(
                action.amount ??
                action.value ??
                0
            );
    }


    return safe;
}


// ============================================================
// PRIVACY-SAFE PAGE URL
// ============================================================
//
// Never transmit:
//
// - query parameters
// - URL fragments
// - username/password from URL
// - tokens
// - email addresses embedded in query strings
//
// Example:
//
// https://example.com/form?email=user@example.com&token=123
//
// becomes:
//
// https://example.com/form
//
// ============================================================

function getPrivacySafePageUrl(
    rawUrl
) {

    if (
        !rawUrl
    ) {

        return "";
    }


    try {

        const url =
            new URL(
                rawUrl
            );


        return (
            `${url.origin}${url.pathname}`
        );

    } catch (_) {

        return "";
    }
}


// ============================================================
// CAPTURE + SANITIZE
// ============================================================
//
// IMPORTANT PRIVACY GUARANTEE:
//
// The raw screenshot is:
//
//     captureVisibleTab()
//             |
//             v
//     content.js
//             |
//             v
//     local redaction
//             |
//             v
//     sanitized screenshot
//
// Raw screenshot is NEVER returned from this function.
//
// ============================================================

async function captureAndSanitize() {

    console.log(
        "[CAPTURE] Starting local capture and sanitization."
    );


    // ========================================================
    // GET ACTIVE TAB
    // ========================================================

    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });


    if (
        !Array.isArray(tabs) ||
        tabs.length === 0
    ) {

        throw new Error(
            "No active browser tab found."
        );
    }


    const tab =
        tabs[0];


    if (
        !tab ||
        !tab.id
    ) {

        throw new Error(
            "Active tab has no valid ID."
        );
    }


    if (
        !Number.isInteger(
            tab.windowId
        )
    ) {

        throw new Error(
            "Active tab has no valid window ID."
        );
    }


    console.log(
        "[CAPTURE] Active tab:",
        tab.id
    );


    // ========================================================
    // PREPARE PRIVACY ENGINE
    // ========================================================

    let prepareResponse;


    try {

        prepareResponse =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "PREPARE_CAPTURE"
                }
            );

    } catch (error) {

        console.error(
            "[CAPTURE] PREPARE_CAPTURE failed:",
            error?.message ||
            error
        );


        throw new Error(
            "Could not communicate with content script. " +
            "Please refresh the webpage and try again."
        );
    }


    if (
        !prepareResponse ||
        typeof prepareResponse !== "object"
    ) {

        throw new Error(
            "Privacy engine returned an invalid response."
        );
    }


    if (
        prepareResponse.success !== true
    ) {

        throw new Error(
            prepareResponse.error ||
            "Privacy engine could not prepare the capture."
        );
    }


    console.log(
        "[PRIVACY] Local PII detection completed:",
        Array.isArray(
            prepareResponse.detections
        )
            ? prepareResponse.detections.length
            : 0,
        "regions"
    );


    // ========================================================
    // SANITIZE DETECTION METADATA
    // ========================================================
    //
    // IMPORTANT:
    //
    // prepareResponse must exist before it is used.
    //
    // Only sanitized detection metadata leaves the background
    // capture boundary.
    //
    // ========================================================

    const safeDetections =
        sanitizeDetectionMetadata(
            prepareResponse.detections || []
        );


    // ========================================================
    // CAPTURE VISIBLE TAB
    // ========================================================

    let screenshot;


    try {

        screenshot =
            await chrome.tabs.captureVisibleTab(
                tab.windowId,
                {
                    format: "png"
                }
            );

    } catch (error) {

        console.error(
            "[CAPTURE] Screenshot capture failed:",
            error?.message ||
            error
        );


        throw new Error(
            "Could not capture the current screen: " +
            (
                error?.message ||
                "Unknown capture error"
            )
        );
    }


    if (
        typeof screenshot !== "string" ||
        screenshot.length === 0
    ) {

        throw new Error(
            "Browser returned an empty screenshot."
        );
    }


    console.log(
        "[CAPTURE] Raw screenshot captured locally."
    );


    // ========================================================
    // LOCAL SANITIZATION
    // ========================================================
    //
    // The raw screenshot exists only inside the extension.
    //
    // It is sent to content.js solely for local redaction.
    //
    // It is NEVER returned to popup.js.
    // It is NEVER sent directly to FastAPI.
    //
    // ========================================================

    let sanitizeResponse;


    try {

        sanitizeResponse =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "SANITIZE_SCREENSHOT",

                    screenshot:
                        screenshot,

                    detections:
                        safeDetections
                }
            );

    } catch (error) {

        console.error(
            "[PRIVACY] SANITIZE_SCREENSHOT failed:",
            error?.message ||
            error
        );


        throw new Error(
            "Could not sanitize the screenshot: " +
            (
                error?.message ||
                "Unknown sanitization error"
            )
        );
    }


    // Explicitly release our reference to the raw screenshot
    // as soon as local sanitization has completed.
    screenshot = null;


    if (
        !sanitizeResponse ||
        typeof sanitizeResponse !== "object"
    ) {

        throw new Error(
            "Sanitization returned an invalid response."
        );
    }


    if (
        sanitizeResponse.success !== true
    ) {

        throw new Error(
            sanitizeResponse.error ||
            "Screenshot sanitization failed."
        );
    }


    if (
        typeof sanitizeResponse.sanitizedImage !== "string" ||
        sanitizeResponse.sanitizedImage.length === 0
    ) {

        throw new Error(
            "Sanitized screenshot was empty."
        );
    }


    console.log(
        "[PRIVACY] Screenshot sanitized locally."
    );


    // ========================================================
    // SANITIZED DOM METADATA
    // ========================================================
    //
    // content.js is responsible for producing safe DOM
    // metadata. background.js intentionally does not copy
    // arbitrary DOM values.
    //
    // The existing popup privacy gate performs another
    // allowlist check before the network request.
    //
    // ========================================================

    const safeDomElements =
        Array.isArray(
            sanitizeResponse.dom_elements
        )
            ? sanitizeResponse.dom_elements
            : (
                Array.isArray(
                    prepareResponse.dom_elements
                )
                    ? prepareResponse.dom_elements
                    : []
            );


    // ========================================================
    // RETURN ONLY SANITIZED DATA
    // ========================================================

    return {

        success: true,

        // Sanitized screenshot only.
        sanitizedImage:
            sanitizeResponse.sanitizedImage,

        // Detection geometry only.
        // No PII values.
        detections:
            safeDetections,

        // DOM metadata produced by the privacy engine.
        dom_elements:
            safeDomElements,

        viewport:
            sanitizeResponse.viewport ||
            prepareResponse.viewport ||
            null,

        // Privacy-safe URL.
        page_url:
            getPrivacySafePageUrl(
                tab.url
            ),

        // These IDs are extension-internal metadata.
        // They are not sent to FastAPI by the background
        // service itself.
        tab_id:
            tab.id,

        window_id:
            tab.windowId
    };
}


// ============================================================
// NORMALIZE + VALIDATE AI ACTION
// ============================================================
//
// The planner is UNTRUSTED INPUT.
//
// Do not trust:
//
//     action.type
//
// Do not trust:
//
//     action.action
//
// Do not trust:
//
//     action.x
//
// Do not trust:
//
//     action.y
//
// Do not trust:
//
//     action.text
//
// Every supported action must pass this boundary.
//
// ============================================================

function normalizeBrowserAction(
    action
) {

    // ========================================================
    // ACTION OBJECT VALIDATION
    // ========================================================

    if (
        !action ||
        typeof action !== "object" ||
        Array.isArray(action)
    ) {

        return {
            type:
                "none",

            error:
                "Invalid AI action object."
        };
    }


    // ========================================================
    // READ ACTION NAME
    // ========================================================

    const actionName =
        String(
            action.action ||
            action.type ||
            ""
        )
            .toLowerCase()
            .trim();


    // ========================================================
    // ALLOWED ACTION CHECK
    // ========================================================

    if (
        !ALLOWED_ACTIONS.has(
            actionName
        )
    ) {

        return {
            type:
                "none",

            error:
                `Unsupported AI action: ${
                    actionName ||
                    "missing"
                }`
        };
    }


    // ========================================================
    // CONFIDENCE
    // ========================================================
    //
    // Confidence is metadata, not authorization.
    //
    // It must never become NaN or Infinity.
    //
    // ========================================================

    const rawConfidence =
        Number(
            action.confidence
        );


    const confidence =
        Number.isFinite(
            rawConfidence
        )
            ? Math.min(
                1,
                Math.max(
                    0,
                    rawConfidence
                )
            )
            : 0;


    // ========================================================
    // NONE
    // ========================================================

    if (
        actionName === "none"
    ) {

        return {
            type:
                "none",

            confidence:
                confidence
        };
    }


    // ========================================================
    // CLICK
    // ========================================================

    if (actionName === "click") {
    const x = Number(
        action?.x ??
        action?.target?.x
    );

    const y = Number(
        action?.y ??
        action?.target?.y
    );

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y)
    ) {
        throw new Error(
            "Invalid click coordinates."
        );
    }

    const submitIntent =
        action?.submitIntent === true ||
        action?.target?.submitIntent === true;

    return {
        type: "click",
        target: {
            x: x,
            y: y,
            submitIntent: submitIntent
        },
        submitIntent: submitIntent,
        confidence: confidence
    };

    }


    // ========================================================
    // TYPE
    // ========================================================

    if (
        actionName === "type"
    ) {

        const x =
            Number(
                action.x ??
                action.target?.x
            );


        const y =
            Number(
                action.y ??
                action.target?.y
            );


        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        ) {

            return {
                type:
                    "none",

                error:
                    "AI returned invalid type coordinates."
            };
        }


        if (
            x < 0 ||
            y < 0
        ) {

            return {
                type:
                    "none",

                error:
                    "AI returned negative type coordinates."
            };
        }


        // ====================================================
        // EXPLICIT VALUE REQUIRED
        // ====================================================

        const value =
            action.text ??
            action.value;


        if (
            value === undefined ||
            value === null
        ) {

            return {
                type:
                    "none",

                error:
                    "TYPE action is missing an explicit value."
            };
        }


        const stringValue =
            String(
                value
            );


        if (
            stringValue.length === 0
        ) {

            return {
                type:
                    "none",

                error:
                    "TYPE action contains an empty value."
            };
        }


        // ====================================================
        // PROTECTED FIELD METADATA
        // ====================================================
        //
        // The background cannot inspect the live DOM.
        //
        // content.js performs the final DOM-level validation.
        //
        // However, if the planner explicitly tells us that the
        // target is a credential field, reject it here too.
        //
        // ====================================================

        const targetMetadata =
            [
                action.fieldType,
                action.inputType,
                action.name,
                action.id,
                action.placeholder,
                action.autocomplete,
                action.role,
                action.targetType
            ]
                .filter(
                    value =>
                        value !== undefined &&
                        value !== null
                )
                .join(" ")
                .toLowerCase();


        if (
            /\b(password|passwd|passcode|credential|credentials|otp|one[- ]time[- ]password|security[- ]code|pin)\b/i
                .test(
                    targetMetadata
                )
        ) {

            return {
                type:
                    "none",

                error:
                    "TYPE action targeted a protected credential field."
            };
        }


        // ====================================================
        // RETURN SAFE TYPE ACTION
        // ====================================================
        //
        // The actual value is required for the local browser
        // operation, but it is NEVER included in console logs.
        //
        // ====================================================

        const submitIntent =
    action?.submitIntent === true ||
    action?.target?.submitIntent === true;

return {
    type: "type",
    target: {
        x: x,
        y: y
    },
    text: stringValue,
    confidence: confidence
};
    }


    // ========================================================
    // SCROLL
    // ========================================================

    if (
        actionName === "scroll"
    ) {

        let amount =
            Number(
                action.amount ??
                action.value
            );


        if (
            !Number.isFinite(
                amount
            )
        ) {

            return {
                type:
                    "none",

                error:
                    "AI returned an invalid scroll amount."
            };
        }


        // Bound one scroll operation.
        amount =
            Math.max(
                -MAX_SCROLL_AMOUNT,
                Math.min(
                    MAX_SCROLL_AMOUNT,
                    amount
                )
            );


        if (
            amount === 0
        ) {

            return {
                type:
                    "none",

                error:
                    "AI returned a zero scroll amount."
            };
        }


        return {

            type:
                "scroll",

            value:
                amount,

            confidence:
                confidence
        };
    }


    // ========================================================
    // WAIT
    // ========================================================

    if (
        actionName === "wait"
    ) {

        let milliseconds =
            Number(
                action.amount ??
                action.value
            );


        if (
            !Number.isFinite(
                milliseconds
            )
        ) {

            return {
                type:
                    "none",

                error:
                    "AI returned an invalid wait duration."
            };
        }


        milliseconds =
            Math.max(
                MIN_WAIT_MS,
                Math.min(
                    MAX_WAIT_MS,
                    milliseconds
                )
            );


        return {

            type:
                "wait",

            value:
                milliseconds,

            confidence:
                confidence
        };
    }


    // ========================================================
    // FALLBACK
    // ========================================================

    return {

        type:
            "none",

        error:
            "Unsupported browser action."
    };
}


// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================
//
// IMPORTANT:
//
// The raw planner action is NEVER forwarded directly.
//
// Flow:
//
//     planner action
//           |
//           v
//     normalizeBrowserAction()
//           |
//           v
//     validated action
//           |
//           v
//     content.js
//
// ============================================================

async function executeBrowserAction(
    action
) {

    // ========================================================
    // NORMALIZE + VALIDATE
    // ========================================================

    const normalizedAction =
        normalizeBrowserAction(
            action
        );


    console.log(
        "[ACTION] Validated planner action:",
        getSafeActionLog(
            normalizedAction
        )
    );


    // ========================================================
    // REJECT INVALID ACTION
    // ========================================================

    if (
        normalizedAction.type === "none" &&
        normalizedAction.error
    ) {

        console.warn(
            "[ACTION] Planner action rejected:",
            normalizedAction.error
        );


        return {

            success:
                false,

            error:
                normalizedAction.error
        };
    }


    // ========================================================
    // GET ACTIVE TAB
    // ========================================================

    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });


    if (
        !Array.isArray(tabs) ||
        tabs.length === 0
    ) {

        return {

            success:
                false,

            error:
                "No active browser tab found."
        };
    }


    const tab =
        tabs[0];


    if (
        !tab ||
        !tab.id
    ) {

        return {

            success:
                false,

            error:
                "Active tab has no valid ID."
        };
    }


    // ========================================================
    // SEND ONLY VALIDATED ACTION
    // ========================================================

    let response;


    try {

        console.log(
            "[ACTION] Sending validated action to content script."
        );


        response =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "EXECUTE_ACTION",

                    action:
                        normalizedAction
                }
            );

    } catch (error) {

        console.error(
            "[ACTION] Content script communication failed:",
            error?.message ||
            error
        );


        return {

            success:
                false,

            error:
                "Could not communicate with content script: " +
                (
                    error?.message ||
                    "Unknown error"
                )
        };
    }


    // ========================================================
    // STRICT RESPONSE VALIDATION
    // ========================================================
    //
    // An undefined or malformed response is NOT success.
    //
    // ========================================================

    if (
        !response ||
        typeof response !== "object"
    ) {

        return {

            success:
                false,

            error:
                "Content script returned an invalid response."
        };
    }


    if (
    response.success !== true
) {
    return {
        success: false,

        action:
            response.action ||
            normalizedAction.type,

        retryable:
            response.retryable === true,

        unsafe:
            response.unsafe === true,

        error:
            response.error ||
            response.message ||
            "Browser action was rejected."
    };

    }


    // ========================================================
    // SAFE RESULT
    // ========================================================

    console.log(
        "[ACTION] Browser action completed:",
        {
            success:
                true,

            action:
                response.action ||
                normalizedAction.type
        }
    );


    return {

        success:
            true,

        action:
            response.action ||
            normalizedAction.type,

        result:
            response
    };
}


// ============================================================
// BENCHMARK
// ============================================================
//
// This section is intentionally separate from the production
// CAPTURE_AND_SANITIZE / EXECUTE_BROWSER_ACTION pipeline.
//
// Purpose:
//   Bridge pii-accuracy-test.html to the existing OCR pipeline
//   (content.js -> ocr.js) without introducing a second raw
//   screenshot exit point and without duplicating the detailed
//   metrics that already live inside ocr.js.
//
// Boundary:
//   - Never returns raw screenshots.
//   - Never returns detected PII text/values.
//   - Only returns type / confidence / detected booleans and
//     the aggregate benchmark report produced by ocr.js.
//
// ============================================================


// Lightweight, background-level counters only.
// Detailed OCR metrics remain the responsibility of ocr.js.
const benchmarkStats = {
    runs: 0,
    successful: 0,
    failed: 0,
    totalLatencyMs: 0
};


// ------------------------------------------------------------
// TIMEOUT WRAPPER
// ------------------------------------------------------------
//
// Prevents the benchmark UI from hanging forever if OCR /
// Tesseract gets stuck inside the content script.
//
// ------------------------------------------------------------

function withTimeout(
    promise,
    timeoutMs = OCR_BENCHMARK_TIMEOUT_MS
) {

    return Promise.race([

        promise,

        new Promise(
            (_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Benchmark timeout."
                            )
                        ),
                    timeoutMs
                )
        )
    ]);
}


// ------------------------------------------------------------
// SANITIZE BENCHMARK RESULT
// ------------------------------------------------------------
//
// Defense-in-depth, mirroring sanitizeDetectionMetadata().
//
// Only classification-level fields are kept. Detected PII
// text, OCR words, and raw screenshots are never copied here,
// even if a compromised or buggy content script were to send
// them.
//
// ------------------------------------------------------------

function sanitizeBenchmarkDetections(
    detections
) {

    if (
        !Array.isArray(detections)
    ) {
        return [];
    }


    return detections
        .map(
            detection => {

                if (
                    !detection ||
                    typeof detection !== "object"
                ) {
                    return null;
                }


                const type =
                    String(
                        detection.type || ""
                    )
                        .toUpperCase()
                        .trim();


                if (
                    !ALLOWED_BENCHMARK_TYPES.has(type)
                ) {
                    return null;
                }


                const rawConfidence =
                    Number(
                        detection.confidence
                    );


                const confidence =
                    Number.isFinite(rawConfidence)
                        ? Math.min(
                            1,
                            Math.max(0, rawConfidence)
                        )
                        : 0;


                return {

                    type,

                    confidence,

                    detected:
                        detection.detected === true
                };
            }
        )
        .filter(Boolean);
}


function sanitizeBenchmarkReport(
    report
) {

    if (
        !report ||
        typeof report !== "object"
    ) {
        return null;
    }


    // Only numeric aggregate fields are forwarded. This
    // object never contains OCR text or PII values, so it
    // is safe to pass through, but we still rebuild it
    // field-by-field rather than trusting the shape as-is.

    const latency =
        report.latency && typeof report.latency === "object"
            ? report.latency
            : {};

    const words =
        report.words && typeof report.words === "object"
            ? report.words
            : {};

    const pii =
        report.pii && typeof report.pii === "object"
            ? report.pii
            : {};

    const confidence =
        report.confidence && typeof report.confidence === "object"
            ? report.confidence
            : {};


    return {

        runs:
            Number(report.runs) || 0,

        latency: {
            averageMs:
                Number(latency.averageMs) || 0,
            minMs:
                Number(latency.minMs) || 0,
            maxMs:
                Number(latency.maxMs) || 0,
            totalMs:
                Number(latency.totalMs) || 0
        },

        words: {
            total:
                Number(words.total) || 0
        },

        pii: {
            total:
                Number(pii.total) || 0,
            accepted:
                Number(pii.accepted) || 0,
            rejected:
                Number(pii.rejected) || 0
        },

        confidence: {
            average:
                Number(confidence.average) || 0,
            threshold:
                Number(confidence.threshold) || 0
        }
    };
}


// ------------------------------------------------------------
// RUN OCR BENCHMARK
// ------------------------------------------------------------
//
// Flow:
//
//   Benchmark HTML
//         |
//         v
//   background.js  (this function)
//         |
//         v
//   active tab -> content.js -> ocr.js
//         |
//         v
//   OCR benchmark result
//         |
//         v
//   background.js -> Benchmark HTML
//
// ------------------------------------------------------------

async function runOCRBenchmark(
    requestId,
    testCases
) {

    console.log(
        `[BENCHMARK] Request ${requestId} started`
    );


    // ========================================================
    // GET ACTIVE TAB
    // ========================================================
    //
    // The benchmark is never allowed to specify an arbitrary
    // tabId. Only the active tab in the current window may be
    // targeted, matching the production capture flow.
    //
    // ========================================================

    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });


    if (
        !Array.isArray(tabs) ||
        tabs.length === 0
    ) {

        const error =
            new Error(
                "No active browser tab found."
            );

        error.code =
            "NO_ACTIVE_TAB";

        throw error;
    }


    const tab =
        tabs[0];


    if (
        !tab ||
        !tab.id
    ) {

        const error =
            new Error(
                "Active tab has no valid ID."
            );

        error.code =
            "NO_ACTIVE_TAB";

        throw error;
    }


    if (
        !Number.isInteger(tab.windowId)
    ) {

        const error =
            new Error(
                "Active tab has no valid window ID."
            );

        error.code =
            "NO_ACTIVE_TAB";

        throw error;
    }


    // ========================================================
    // CAPTURE VISIBLE TAB
    // ========================================================
    //
    // The OCR benchmark needs a screenshot of whatever is
    // currently visible in the active tab, exactly like the
    // production capture flow. The benchmark page is expected
    // to scroll the relevant ground-truth/negative-sample
    // section into view before requesting each run.
    //
    // ========================================================

    let screenshot;


    try {

        screenshot =
            await chrome.tabs.captureVisibleTab(
                tab.windowId,
                {
                    format: "png"
                }
            );

    } catch (error) {

        const wrapped =
            new Error(
                "Could not capture the current screen: " +
                (
                    error?.message ||
                    "Unknown capture error"
                )
            );

        wrapped.code =
            "OCR_BENCHMARK_FAILED";

        throw wrapped;
    }


    if (
        typeof screenshot !== "string" ||
        screenshot.length === 0
    ) {

        const error =
            new Error(
                "Browser returned an empty screenshot."
            );

        error.code =
            "OCR_BENCHMARK_FAILED";

        throw error;
    }


    // ========================================================
    // FORWARD TO CONTENT SCRIPT
    // ========================================================

    let response;


    try {

        response =
            await withTimeout(
                chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type:
                            "RUN_OCR_BENCHMARK",

                        requestId,

                        testCases,

                        screenshot
                    }
                ),
                OCR_BENCHMARK_TIMEOUT_MS
            );

    } catch (error) {

        const isTimeout =
            String(
                error?.message || ""
            ).includes("timeout");

        const wrapped =
            new Error(
                isTimeout
                    ? "OCR benchmark timed out."
                    : "Could not communicate with content script. " +
                      "Please refresh the webpage and try again."
            );

        wrapped.code =
            isTimeout
                ? "OCR_TIMEOUT"
                : "CONTENT_SCRIPT_UNAVAILABLE";

        throw wrapped;
    }


    if (
        !response ||
        typeof response !== "object"
    ) {

        const error =
            new Error(
                "Content script returned an invalid benchmark response."
            );

        error.code =
            "OCR_BENCHMARK_FAILED";

        throw error;
    }


    if (
        response.success !== true
    ) {

        const error =
            new Error(
                response.error ||
                "OCR benchmark failed."
            );

        error.code =
            response.code ||
            "OCR_BENCHMARK_FAILED";

        throw error;
    }


    // ========================================================
    // SANITIZE RESULT
    // ========================================================
    //
    // Only classification-level fields and the aggregate
    // report leave this boundary. No screenshots, no OCR
    // text, no detected PII values.
    //
    // ========================================================

    const safeDetections =
        sanitizeBenchmarkDetections(
            response.detections
        );

    const safeReport =
        sanitizeBenchmarkReport(
            response.report
        );


    console.log(
        `[BENCHMARK] Request ${requestId} completed`
    );


    return {

        requestId,

        success:
            true,

        detections:
            safeDetections,

        report:
            safeReport
    };
}




// ============================================================
// MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {

        console.log(
            "[MESSAGE]",
            message?.type
        );


        // ====================================================
        // CAPTURE + SANITIZE
        // ====================================================

        if (
            message?.type ===
            "CAPTURE_AND_SANITIZE"
        ) {

            // ------------------------------------------------
            // TRUST BOUNDARY
            // ------------------------------------------------

            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {

                console.warn(
                    "[CAPTURE] Rejected request from an unexpected sender."
                );


                sendResponse({

                    success:
                        false,

                    error:
                        "Unauthorized capture request."
                });


                return false;
            }


            // ------------------------------------------------
            // ASYNC CAPTURE
            // ------------------------------------------------

            captureAndSanitize()

                .then(
                    result => {

                        console.log(
                            "[CAPTURE] Capture + sanitize complete."
                        );


                        sendResponse(
                            result
                        );
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "[CAPTURE] Pipeline error:",
                            error?.message ||
                            error
                        );


                        sendResponse({

                            success:
                                false,

                            error:
                                error?.message ||
                                "Capture pipeline failed."
                        });
                    }
                );


            // Keep the message channel open for
            // the asynchronous response.

            return true;
        }


        // ====================================================
        // EXECUTE BROWSER ACTION
        // ====================================================

        if (
            message?.type ===
            "EXECUTE_BROWSER_ACTION"
        ) {

            // ------------------------------------------------
            // TRUST BOUNDARY
            // ------------------------------------------------

            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {

                console.warn(
                    "[ACTION] Rejected request from an unexpected sender."
                );


                sendResponse({

                    success:
                        false,

                    error:
                        "Unauthorized action request."
                });


                return false;
            }


            console.log(
                "[ACTION] EXECUTE_BROWSER_ACTION received:",
                getSafeActionLog(
                    message.action
                )
            );


            // ------------------------------------------------
            // EXECUTE ASYNC
            // ------------------------------------------------

            executeBrowserAction(
                message.action
            )

                .then(
                    result => {

                        if (
                            result?.success === true
                        ) {

                            sendResponse({

                                success:
                                    true,

                                result:
                                    result
                            });


                            return;
                        }


                        sendResponse({

                            success:
                                false,

                            error:
                                result?.error ||
                                "Browser action was rejected."
                        });
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "[ACTION] Unexpected browser action error:",
                            error?.message ||
                            error
                        );


                        sendResponse({

                            success:
                                false,

                            error:
                                error?.message ||
                                "Browser action failed."
                        });
                    }
                );


            // Keep the message channel open for
            // the asynchronous response.

            return true;
        }


        // ====================================================
        // BENCHMARK: RUN OCR BENCHMARK
        // ====================================================
        //
        // Kept separate from CAPTURE_AND_SANITIZE so benchmark
        // code can never accidentally weaken the production
        // privacy boundary.
        //
        // ====================================================

        if (
            message?.type ===
            "RUN_OCR_BENCHMARK"
        ) {

            // ------------------------------------------------
            // BASIC MESSAGE SHAPE
            // ------------------------------------------------

            if (
                !message ||
                typeof message !== "object"
            ) {

                sendResponse({

                    success:
                        false,

                    error:
                        "Invalid benchmark request.",

                    code:
                        "INVALID_BENCHMARK_REQUEST",

                    retryable:
                        false
                });

                return false;
            }


            // ------------------------------------------------
            // TRUST BOUNDARY
            // ------------------------------------------------

            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {

                console.warn(
                    "[BENCHMARK] Rejected request from an unexpected sender."
                );

                sendResponse({

                    success:
                        false,

                    error:
                        "Unauthorized request.",

                    code:
                        "INVALID_BENCHMARK_REQUEST",

                    retryable:
                        false
                });

                return false;
            }


            // ------------------------------------------------
            // PAYLOAD VALIDATION
            // ------------------------------------------------

            const testCases =
                Array.isArray(message.testCases)
                    ? message.testCases
                          .map(
                              testCase =>
                                  String(testCase || "")
                                      .toUpperCase()
                                      .trim()
                          )
                          .filter(
                              testCase =>
                                  ALLOWED_BENCHMARK_TYPES.has(
                                      testCase
                                  )
                          )
                    : [];


            if (testCases.length === 0) {

                sendResponse({

                    success:
                        false,

                    error:
                        "No benchmark test cases supplied.",

                    code:
                        "INVALID_BENCHMARK_REQUEST",

                    retryable:
                        false
                });

                return false;
            }


            const requestId =
                crypto.randomUUID();


            console.log(
                "[BENCHMARK] OCR test started"
            );

            console.log(
                `[BENCHMARK] Request ${requestId}`,
                `testCases=${testCases.length}`
            );


            // ------------------------------------------------
            // EXECUTE ASYNC
            // ------------------------------------------------

            benchmarkStats.runs += 1;

            const benchmarkStart =
                Date.now();


            runOCRBenchmark(
                requestId,
                testCases
            )

                .then(
                    result => {

                        benchmarkStats.successful += 1;

                        benchmarkStats.totalLatencyMs +=
                            Date.now() - benchmarkStart;


                        result.detections?.forEach(
                            detection => {

                                console.log(
                                    `[BENCHMARK] Test case: ${detection.type}`
                                );

                                console.log(
                                    `[BENCHMARK] Detected: ${detection.detected}`
                                );

                                console.log(
                                    `[BENCHMARK] Confidence: ${detection.confidence}`
                                );
                            }
                        );


                        sendResponse(
                            result
                        );
                    }
                )

                .catch(
                    error => {

                        benchmarkStats.failed += 1;

                        benchmarkStats.totalLatencyMs +=
                            Date.now() - benchmarkStart;


                        console.error(
                            "[BENCHMARK] Pipeline error:",
                            error?.message ||
                            error
                        );


                        sendResponse({

                            requestId,

                            success:
                                false,

                            error:
                                error?.message ||
                                "OCR benchmark failed.",

                            code:
                                error?.code ||
                                "OCR_BENCHMARK_FAILED",

                            retryable:
                                error?.code === "OCR_TIMEOUT" ||
                                error?.code === "CONTENT_SCRIPT_UNAVAILABLE"
                        });
                    }
                );


            // Keep the message channel open for
            // the asynchronous response.

            return true;
        }


        // ====================================================
        // UNKNOWN MESSAGE
        // ====================================================

        console.warn(
            "[MESSAGE] Unknown background message:",
            message?.type
        );


        return false;
    }
);