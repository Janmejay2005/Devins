// ============================================================
// DEVINS PRIVACY BROWSER AGENT
// background.js
// ============================================================

console.log("[SIH] Privacy Agent background service started");

// ============================================================
// CONFIG
// ============================================================

const ALLOWED_ACTIONS = new Set([
    "click",
    "type",
    "scroll",
    "wait",
    "none"
]);

const MAX_SCROLL_AMOUNT = 1500;
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 5000;

const PREPARE_CAPTURE_TIMEOUT_MS = 10000;
const SANITIZE_CAPTURE_TIMEOUT_MS = 90000;
const PERCEPTION_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 15000;
const OCR_BENCHMARK_TIMEOUT_MS = 15000;

const ALLOWED_BENCHMARK_TYPES = new Set([
    "EMAIL",
    "PHONE",
    "AADHAAR",
    "PAN",
    "CREDIT_CARD",
    "PASSWORD"
]);

// Firefox background pages have window/document.
// Chrome MV3 service workers do not.
const IS_EXTENSION_DOCUMENT_CONTEXT =
    typeof window !== "undefined" &&
    typeof document !== "undefined";

const USER_AGENT =
    typeof navigator !== "undefined"
        ? navigator.userAgent || ""
        : "";

const IS_FIREFOX_BROWSER =
    /Firefox\/\d+/i.test(USER_AGENT) &&
    !/Chrome\/\d+|Chromium\/\d+|Edg\/\d+|OPR\/\d+/i.test(
        USER_AGENT
    );

// ============================================================
// HELPERS
// ============================================================

function isTrustedExtensionSender(sender) {
    return Boolean(
        sender &&
        sender.id &&
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        sender.id === chrome.runtime.id
    );
}

function createRequestId(prefix = "req") {
    try {
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
        ) {
            return `${prefix}_${crypto.randomUUID()}`;
        }
    } catch (_) {}

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2)
    );
}

function withTimeout(
    promise,
    timeoutMs,
    timeoutMessage
) {
    let timeoutId = null;

    const timeoutPromise =
        new Promise(
            (_, reject) => {
                timeoutId = setTimeout(
                    () => {
                        reject(
                            new Error(
                                timeoutMessage
                            )
                        );
                    },
                    timeoutMs
                );
            }
        );

    return Promise.race([
        promise.finally(
            () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                }
            }
        ),
        timeoutPromise
    ]);
}

async function sendTabMessage(
    tabId,
    message,
    timeoutMs,
    operationName
) {
    if (!Number.isInteger(tabId)) {
        throw new Error(
            `${operationName}: invalid tab ID.`
        );
    }

    try {
        return await withTimeout(
            chrome.tabs.sendMessage(
                tabId,
                message
            ),
            timeoutMs,
            `${operationName} timed out.`
        );
    } catch (error) {
        throw new Error(
            `${operationName} failed: ` +
            (
                error?.message ||
                "Unknown error"
            )
        );
    }
}

// ============================================================
// FIREFOX FACE SANDBOX
// ============================================================

let firefoxFaceFrame = null;
let firefoxFaceReady = null;

const firefoxFacePending =
    new Map();

function createFirefoxFaceSandbox() {
    if (!IS_FIREFOX_BROWSER) {
        return Promise.reject(
            new Error(
                "Firefox face sandbox requested outside Firefox."
            )
        );
    }

    if (!IS_EXTENSION_DOCUMENT_CONTEXT) {
        return Promise.reject(
            new Error(
                "Firefox face sandbox requires an extension document context."
            )
        );
    }

    if (firefoxFaceFrame) {
        return Promise.resolve(
            firefoxFaceFrame
        );
    }

    if (firefoxFaceReady) {
        return firefoxFaceReady;
    }

    firefoxFaceReady =
        new Promise(
            function (
                resolve,
                reject
            ) {
                const iframe =
                    document.createElement(
                        "iframe"
                    );

                iframe.style.display =
                    "none";

                iframe.src =
                    chrome.runtime.getURL(
                        "sandbox.html"
                    );

                const cleanup = () => {
                    if (
                        iframe &&
                        iframe.parentNode
                    ) {
                        iframe.parentNode.removeChild(
                            iframe
                        );
                    }
                };

                const timeoutId =
                    setTimeout(
                        () => {
                            window.removeEventListener(
                                "message",
                                onReady
                            );

                            firefoxFaceReady =
                                null;

                            cleanup();

                            reject(
                                new Error(
                                    "Firefox face sandbox initialization timed out."
                                )
                            );
                        },
                        20000
                    );

                function onReady(event) {
                    if (
                        event.source !==
                        iframe.contentWindow
                    ) {
                        return;
                    }

                    const message =
                        event.data;

                    if (
                        !message ||
                        message.type !==
                        "DEVINS_FACE_SANDBOX_READY"
                    ) {
                        return;
                    }

                    clearTimeout(
                        timeoutId
                    );

                    window.removeEventListener(
                        "message",
                        onReady
                    );

                    firefoxFaceFrame =
                        iframe;

                    console.log(
                        "[FACE-BG] Firefox face sandbox ready."
                    );

                    resolve(
                        iframe
                    );
                }

                window.addEventListener(
                    "message",
                    onReady
                );

                document.documentElement.appendChild(
                    iframe
                );
            }
        );

    return firefoxFaceReady;
}

// This listener exists only inside Firefox's extension document context.
// Chrome MV3 service workers never execute this block.
if (
    IS_FIREFOX_BROWSER &&
    IS_EXTENSION_DOCUMENT_CONTEXT
) {
    window.addEventListener(
        "message",
        function (event) {
            if (
                !firefoxFaceFrame ||
                event.source !==
                firefoxFaceFrame.contentWindow
            ) {
                return;
            }

            const message =
                event.data;

            if (
                !message ||
                message.type !==
                "DEVINS_FACE_RESULT"
            ) {
                return;
            }

            const requestId =
                message.requestId;

            const pending =
                firefoxFacePending.get(
                    requestId
                );

            if (!pending) {
                return;
            }

            firefoxFacePending.delete(
                requestId
            );

            clearTimeout(
                pending.timeoutId
            );

            if (
                message.success !== true
            ) {
                pending.reject(
                    new Error(
                        message.error ||
                        "Firefox face sandbox failed."
                    )
                );

                return;
            }

            pending.resolve(
                Array.isArray(
                    message.detections
                )
                    ? message.detections
                    : []
            );
        }
    );
}

async function runFirefoxFaceDetection(
    screenshot
) {
    if (!IS_FIREFOX_BROWSER) {
        throw new Error(
            "Firefox face detection is unavailable in this browser."
        );
    }

    if (!IS_EXTENSION_DOCUMENT_CONTEXT) {
        throw new Error(
            "Firefox face detection requires the extension document context."
        );
    }

    if (
        typeof screenshot !== "string" ||
        !screenshot.startsWith(
            "data:image/"
        )
    ) {
        throw new Error(
            "Invalid screenshot supplied to Firefox face sandbox."
        );
    }

    console.log(
        "[FACE-BG] Starting Firefox sandbox face detection."
    );

    const iframe =
        await createFirefoxFaceSandbox();

    const requestId =
        createRequestId("face");

    return new Promise(
        function (
            resolve,
            reject
        ) {
            const timeoutId =
                setTimeout(
                    () => {
                        firefoxFacePending.delete(
                            requestId
                        );

                        reject(
                            new Error(
                                "Firefox face sandbox detection timed out."
                            )
                        );
                    },
                    45000
                );

            firefoxFacePending.set(
                requestId,
                {
                    resolve,
                    reject,
                    timeoutId
                }
            );

            try {
                iframe.contentWindow.postMessage(
                    {
                        type:
                            "DEVINS_FACE_REQUEST",
                        requestId,
                        screenshot
                    },
                    "*"
                );
            } catch (error) {
                firefoxFacePending.delete(
                    requestId
                );

                clearTimeout(
                    timeoutId
                );

                reject(
                    error
                );
            }
        }
    );
}

// ============================================================
// PRIVACY METADATA
// ============================================================

function sanitizeDetectionMetadata(
    detections
) {
    if (!Array.isArray(detections)) {
        return [];
    }

    return detections
        .map(
            detection => {
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
                    const values = [
                        Number(sourceRect.left),
                        Number(sourceRect.top),
                        Number(sourceRect.right),
                        Number(sourceRect.bottom),
                        Number(sourceRect.width),
                        Number(sourceRect.height)
                    ];

                    if (
                        values.every(
                            Number.isFinite
                        )
                    ) {
                        rect = {
                            left: values[0],
                            top: values[1],
                            right: values[2],
                            bottom: values[3],
                            width: values[4],
                            height: values[5]
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
        .filter(Boolean);
}

function getPrivacySafePageUrl(
    rawUrl
) {
    if (!rawUrl) {
        return "";
    }

    try {
        const url =
            new URL(rawUrl);

        return (
            `${url.origin}${url.pathname}`
        );
    } catch (_) {
        return "";
    }
}

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
                action.submitIntent === true ||
                action.target?.submitIntent === true
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
// CAPTURE + SANITIZE
// ============================================================

async function captureAndSanitize() {
    console.log(
        "[CAPTURE] Starting local capture and sanitization."
    );

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
        !Number.isInteger(tab.id)
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

    let prepareResponse;

    try {
        prepareResponse =
            await sendTabMessage(
                tab.id,
                {
                    type:
                        "PREPARE_CAPTURE"
                },
                PREPARE_CAPTURE_TIMEOUT_MS,
                "PREPARE_CAPTURE"
            );
    } catch (error) {
        console.error(
            "[CAPTURE] PREPARE_CAPTURE failed:",
            error.message
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

    const safeDetections =
        sanitizeDetectionMetadata(
            prepareResponse.detections || []
        );

    console.log(
        "[PRIVACY] Local PII detection completed:",
        safeDetections.length,
        "regions"
    );

    let screenshot = null;

    try {
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

        let sanitizeResponse;

        try {
            sanitizeResponse =
                await sendTabMessage(
                    tab.id,
                    {
                        type:
                            "SANITIZE_SCREENSHOT",

                        screenshot,

                        detections:
                            safeDetections
                    },
                    SANITIZE_CAPTURE_TIMEOUT_MS,
                    "SANITIZE_SCREENSHOT"
                );
        } catch (error) {
            console.error(
                "[PRIVACY] SANITIZE_SCREENSHOT failed:",
                error.message
            );

            throw new Error(
                "Could not sanitize the screenshot: " +
                error.message
            );
        }

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
            typeof sanitizeResponse.sanitizedImage !==
                "string" ||
            sanitizeResponse.sanitizedImage.length === 0
        ) {
            throw new Error(
                "Sanitized screenshot was empty."
            );
        }

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

        console.log(
            "[PRIVACY] Screenshot sanitized locally."
        );

        return {
            success: true,

            sanitizedImage:
                sanitizeResponse.sanitizedImage,

            detections:
                safeDetections,

            dom_elements:
                safeDomElements,

            viewport:
                sanitizeResponse.viewport ||
                prepareResponse.viewport ||
                null,

            page_url:
                getPrivacySafePageUrl(
                    tab.url
                ),

            tab_id:
                tab.id,

            window_id:
                tab.windowId
        };
    } finally {
        screenshot = null;
    }
}

// ============================================================
// ACTION VALIDATION
// ============================================================

function normalizeAgentTarget(
    target
) {
    if (
        !target ||
        typeof target !== "object" ||
        Array.isArray(target)
    ) {
        return null;
    }

    const text =
        typeof target.text === "string"
            ? target.text.trim()
            : "";

    const label =
        typeof target.label === "string"
            ? target.label.trim()
            : "";

    const name =
        typeof target.name === "string"
            ? target.name.trim()
            : "";

    if (
        !text &&
        !label &&
        !name
    ) {
        return null;
    }

    return {
        ...(text
            ? {
                text:
                    text.slice(0, 120)
            }
            : {}),

        ...(label
            ? {
                label:
                    label.slice(0, 120)
            }
            : {}),

        ...(name
            ? {
                name:
                    name.slice(0, 120)
            }
            : {})
    };
}

function normalizeBrowserAction(
    action
) {
    if (
        !action ||
        typeof action !== "object" ||
        Array.isArray(action)
    ) {
        return {
            type: "none",
            error:
                "Invalid AI action object."
        };
    }

    const actionName =
        String(
            action.action ||
            action.type ||
            ""
        )
            .toLowerCase()
            .trim();

    if (
        !ALLOWED_ACTIONS.has(
            actionName
        )
    ) {
        return {
            type: "none",
            error:
                `Unsupported AI action: ${
                    actionName || "missing"
                }`
        };
    }

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

    if (
        actionName === "none"
    ) {
        return {
            type: "none",
            confidence
        };
    }

    if (
        actionName === "click"
    ) {
        const semanticTarget =
            normalizeAgentTarget(
                action.target
            );

        const submitIntent =
            action.submitIntent === true ||
            action.target?.submitIntent === true;

        if (semanticTarget) {
            return {
                type: "click",

                target: {
                    ...semanticTarget,
                    submitIntent
                },

                submitIntent,
                confidence
            };
        }

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
            !Number.isFinite(y) ||
            x < 0 ||
            y < 0
        ) {
            return {
                type: "none",
                error:
                    "Invalid click coordinates."
            };
        }

        return {
            type: "click",

            target: {
                x,
                y,
                submitIntent
            },

            submitIntent,
            confidence
        };
    }

    if (
        actionName === "type"
    ) {
        const semanticTarget =
            normalizeAgentTarget(
                action.target
            );

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
            !semanticTarget &&
            (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            )
        ) {
            return {
                type: "none",
                error:
                    "AI returned invalid type coordinates."
            };
        }

        if (
            !semanticTarget &&
            (
                x < 0 ||
                y < 0
            )
        ) {
            return {
                type: "none",
                error:
                    "AI returned negative type coordinates."
            };
        }

        const value =
            action.text ??
            action.value;

        if (
            value === undefined ||
            value === null
        ) {
            return {
                type: "none",
                error:
                    "TYPE action is missing an explicit value."
            };
        }

        const stringValue =
            String(value);

        if (
            stringValue.length === 0
        ) {
            return {
                type: "none",
                error:
                    "TYPE action contains an empty value."
            };
        }

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
                    item =>
                        item !== undefined &&
                        item !== null
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
                type: "none",
                error:
                    "TYPE action targeted a protected credential field."
            };
        }

        const submitIntent =
            action.submitIntent === true ||
            action.target?.submitIntent === true;

        return {
            type: "type",

            target:
                semanticTarget
                    ? {
                        ...semanticTarget,
                        submitIntent
                    }
                    : {
                        x,
                        y,
                        submitIntent
                    },

            text:
                stringValue,

            submitIntent,

            confidence
        };
    }

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
                type: "none",
                error:
                    "AI returned an invalid scroll amount."
            };
        }

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
                type: "none",
                error:
                    "AI returned a zero scroll amount."
            };
        }

        return {
            type: "scroll",
            value: amount,
            confidence
        };
    }

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
                type: "none",
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
            type: "wait",
            value: milliseconds,
            confidence
        };
    }

    return {
        type: "none",
        error:
            "Unsupported browser action."
    };
}

// ============================================================
// FRESH PERCEPTION
// ============================================================

async function requestFreshAgentPerception(
    tabId
) {
    if (!Number.isInteger(tabId)) {
        return {
            success: false,
            error:
                "Invalid tab ID."
        };
    }

    try {
        const response =
            await sendTabMessage(
                tabId,
                {
                    type:
                        "GET_AGENT_PERCEPTION"
                },
                PERCEPTION_TIMEOUT_MS,
                "GET_AGENT_PERCEPTION"
            );

        if (
            !response ||
            response.success !== true
        ) {
            return {
                success: false,
                error:
                    response?.error ||
                    "Fresh perception failed."
            };
        }

        if (
            !response.perception ||
            !Array.isArray(
                response.perception.dom
            )
        ) {
            return {
                success: false,
                error:
                    "Fresh perception returned invalid data."
            };
        }

        console.log(
            "[PHASE 6][PERCEPTION] Received:",
            {
                generation:
                    response.perception.generation,

                elements:
                    response.perception.elementCount,

                visible:
                    response.perception.visibleElementCount
            }
        );

        return response;
    } catch (error) {
        console.error(
            "[PHASE 6][PERCEPTION] Communication failed:",
            error?.message ||
            error
        );

        return {
            success: false,
            error:
                "Could not communicate with content script."
        };
    }
}

// ============================================================
// EXECUTE ACTION
// ============================================================

async function executeBrowserAction(
    action
) {
    let plannerAction =
        action;

    if (
        plannerAction?.action &&
        typeof plannerAction.action ===
            "object"
    ) {
        plannerAction =
            plannerAction.action;
    }

    if (
        plannerAction?.result?.action &&
        typeof plannerAction.result.action ===
            "object"
    ) {
        plannerAction =
            plannerAction.result.action;
    }

    console.log(
        "[ACTION] Input:",
        {
            action:
                plannerAction?.action ||
                plannerAction?.type ||
                "missing"
        }
    );

    const normalizedAction =
        normalizeBrowserAction(
            plannerAction
        );

    console.log(
        "[ACTION] Validated:",
        getSafeActionLog(
            normalizedAction
        )
    );

    if (
        normalizedAction.type === "none" &&
        normalizedAction.error
    ) {
        return {
            success: false,
            error:
                normalizedAction.error
        };
    }

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
            success: false,
            error:
                "No active browser tab found."
        };
    }

    const tab =
        tabs[0];

    if (
        !tab ||
        !Number.isInteger(tab.id)
    ) {
        return {
            success: false,
            error:
                "Active tab has no valid ID."
        };
    }

    const perception =
        await requestFreshAgentPerception(
            tab.id
        );

    if (
        !perception.success
    ) {
        return {
            success: false,
            action:
                "perception_failed",
            retryable:
                true,
            error:
                perception.error
        };
    }

    let response;

    try {
        response =
            await sendTabMessage(
                tab.id,
                {
                    type:
                        "EXECUTE_ACTION",

                    action:
                        normalizedAction
                },
                ACTION_TIMEOUT_MS,
                "EXECUTE_ACTION"
            );
    } catch (error) {
        console.error(
            "[ACTION] Content script communication failed:",
            error.message
        );

        return {
            success: false,
            error:
                error.message
        };
    }

    if (
        !response ||
        typeof response !== "object"
    ) {
        return {
            success: false,
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

    console.log(
        "[ACTION] Browser action completed:",
        {
            action:
                response.action ||
                normalizedAction.type
        }
    );

    return {
        success: true,

        action:
            response.action ||
            normalizedAction.type,

        result:
            response
    };
}

// ============================================================
// OCR BENCHMARK
// ============================================================

const benchmarkStats = {
    runs: 0,
    successful: 0,
    failed: 0,
    totalLatencyMs: 0
};

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
                    !ALLOWED_BENCHMARK_TYPES.has(
                        type
                    )
                ) {
                    return null;
                }

                const rawConfidence =
                    Number(
                        detection.confidence
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

    const latency =
        report.latency &&
        typeof report.latency ===
            "object"
            ? report.latency
            : {};

    const words =
        report.words &&
        typeof report.words ===
            "object"
            ? report.words
            : {};

    const pii =
        report.pii &&
        typeof report.pii ===
            "object"
            ? report.pii
            : {};

    const confidence =
        report.confidence &&
        typeof report.confidence ===
            "object"
            ? report.confidence
            : {};

    return {
        runs:
            Number(
                report.runs
            ) || 0,

        latency: {
            averageMs:
                Number(
                    latency.averageMs
                ) || 0,

            minMs:
                Number(
                    latency.minMs
                ) || 0,

            maxMs:
                Number(
                    latency.maxMs
                ) || 0,

            totalMs:
                Number(
                    latency.totalMs
                ) || 0
        },

        words: {
            total:
                Number(
                    words.total
                ) || 0
        },

        pii: {
            total:
                Number(
                    pii.total
                ) || 0,

            accepted:
                Number(
                    pii.accepted
                ) || 0,

            rejected:
                Number(
                    pii.rejected
                ) || 0
        },

        confidence: {
            average:
                Number(
                    confidence.average
                ) || 0,

            threshold:
                Number(
                    confidence.threshold
                ) || 0
        }
    };
}

async function runOCRBenchmark(
    requestId,
    testCases
) {
    console.log(
        `[BENCHMARK] Request ${requestId} started`
    );

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
        !Number.isInteger(tab.id) ||
        !Number.isInteger(tab.windowId)
    ) {
        const error =
            new Error(
                "Active tab is invalid."
            );

        error.code =
            "NO_ACTIVE_TAB";

        throw error;
    }

    let screenshot;

    try {
        screenshot =
            await chrome.tabs.captureVisibleTab(
                tab.windowId,
                {
                    format: "png"
                }
            );

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

        const response =
            await sendTabMessage(
                tab.id,
                {
                    type:
                        "RUN_OCR_BENCHMARK",

                    requestId,

                    testCases,

                    screenshot
                },
                OCR_BENCHMARK_TIMEOUT_MS,
                "RUN_OCR_BENCHMARK"
            );

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

        return {
            requestId,

            success: true,

            detections:
                sanitizeBenchmarkDetections(
                    response.detections
                ),

            report:
                sanitizeBenchmarkReport(
                    response.report
                )
        };
    } finally {
        screenshot = null;
    }
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
        const messageType =
            message?.type;

        console.log(
            "[MESSAGE]",
            messageType
        );

        // ----------------------------
        // Firefox face detection
        // ----------------------------

        if (
            messageType ===
            "FIREFOX_FACE_DETECT"
        ) {
            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Unauthorized face-detection request."
                });

                return false;
            }

            if (
                !IS_FIREFOX_BROWSER ||
                !IS_EXTENSION_DOCUMENT_CONTEXT
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Firefox face bridge is unavailable in this context."
                });

                return false;
            }

            runFirefoxFaceDetection(
                message?.screenshot
            )
                .then(
                    detections => {
                        sendResponse({
                            success: true,

                            detections:
                                Array.isArray(
                                    detections
                                )
                                    ? detections
                                    : []
                        });
                    }
                )
                .catch(
                    error => {
                        console.error(
                            "[FACE] Firefox bridge error:",
                            error?.message ||
                            error
                        );

                        sendResponse({
                            success: false,
                            error:
                                error?.message ||
                                "Firefox face detection failed."
                        });
                    }
                );

            return true;
        }

        // ----------------------------
        // Capture + sanitize
        // ----------------------------

        if (
            messageType ===
            "CAPTURE_AND_SANITIZE"
        ) {
            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Unauthorized capture request."
                });

                return false;
            }

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
                            success: false,
                            error:
                                error?.message ||
                                "Capture pipeline failed."
                        });
                    }
                );

            return true;
        }

        // ----------------------------
        // Browser action
        // ----------------------------

        if (
            messageType ===
            "EXECUTE_BROWSER_ACTION"
        ) {
            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Unauthorized action request."
                });

                return false;
            }

            console.log(
                "[ACTION] EXECUTE_BROWSER_ACTION received:",
                getSafeActionLog(
                    message?.action
                )
            );

            executeBrowserAction(
                message?.action
            )
                .then(
                    result => {
                        if (
                            result?.success === true
                        ) {
                            sendResponse({
                                success: true,
                                result
                            });

                            return;
                        }

                        sendResponse({
                            success: false,

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
                            success: false,
                            error:
                                error?.message ||
                                "Browser action failed."
                        });
                    }
                );

            return true;
        }

        // ----------------------------
        // OCR benchmark
        // ----------------------------

        if (
            messageType ===
            "RUN_OCR_BENCHMARK"
        ) {
            if (
                !message ||
                typeof message !== "object"
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Invalid benchmark request.",
                    code:
                        "INVALID_BENCHMARK_REQUEST",
                    retryable: false
                });

                return false;
            }

            if (
                !isTrustedExtensionSender(
                    sender
                )
            ) {
                sendResponse({
                    success: false,
                    error:
                        "Unauthorized request.",
                    code:
                        "INVALID_BENCHMARK_REQUEST",
                    retryable: false
                });

                return false;
            }

            const testCases =
                Array.isArray(
                    message.testCases
                )
                    ? message.testCases
                        .map(
                            testCase =>
                                String(
                                    testCase || ""
                                )
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

            if (
                testCases.length === 0
            ) {
                sendResponse({
                    success: false,
                    error:
                        "No benchmark test cases supplied.",
                    code:
                        "INVALID_BENCHMARK_REQUEST",
                    retryable: false
                });

                return false;
            }

            const requestId =
                createRequestId(
                    "ocr"
                );

            const benchmarkStart =
                Date.now();

            benchmarkStats.runs += 1;

            runOCRBenchmark(
                requestId,
                testCases
            )
                .then(
                    result => {
                        benchmarkStats.successful += 1;

                        benchmarkStats.totalLatencyMs +=
                            Date.now() -
                            benchmarkStart;

                        result.detections?.forEach(
                            detection => {
                                console.log(
                                    `[BENCHMARK] ${detection.type}: detected=${detection.detected} confidence=${detection.confidence}`
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
                            Date.now() -
                            benchmarkStart;

                        console.error(
                            "[BENCHMARK] Pipeline error:",
                            error?.message ||
                            error
                        );

                        sendResponse({
                            requestId,

                            success: false,

                            error:
                                error?.message ||
                                "OCR benchmark failed.",

                            code:
                                error?.code ||
                                (
                                    String(
                                        error?.message ||
                                        ""
                                    ).includes(
                                        "timed out"
                                    )
                                        ? "OCR_TIMEOUT"
                                        : "OCR_BENCHMARK_FAILED"
                                ),

                            retryable:
                                String(
                                    error?.message ||
                                    ""
                                ).includes(
                                    "timed out"
                                )
                        });
                    }
                );

            return true;
        }

        console.warn(
            "[MESSAGE] Unknown background message:",
            messageType
        );

        return false;
    }
);