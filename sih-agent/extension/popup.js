// ============================================================
// SIH PRIVACY BROWSER AGENT
// popup.js
//
// COMPLETE MULTI-STEP PRIVATE AGENT
//
// FLOW:
//
// 1. Read user task
// 2. Capture current tab locally
// 3. Detect PII locally
// 4. Sanitize screenshot locally
// 5. Send ONLY sanitized screenshot + safe metadata + task
// 6. Receive one browser action
// 7. Execute action locally
// 8. Capture a NEW sanitized state
// 9. If task is compound, plan next safe action
// 10. Repeat until task is complete
//
// PRIVACY:
//
// - Raw screenshot never goes to FastAPI.
// - PII detection happens locally.
// - Screenshot redaction happens locally.
// - Safe DOM metadata only.
// - Normal webpage remains readable/editable.
// - PII is NOT visually masked on the live webpage.
// - Sensitive pixels are masked only in captured screenshots.
// - Password / credential / OTP fields are never typed into.
// - The agent never reads an existing sensitive value.
// - TYPE requires an explicit user-provided value.
// ============================================================

console.log(
    " SIH Privacy Agent popup loaded"
);


// ============================================================
// DOM ELEMENTS
// ============================================================

const captureButton =
    document.getElementById(
        "captureButton"
    );

const result =
    document.getElementById(
        "result"
    );

const resultTitle =
    document.getElementById(
        "resultTitle"
    );

const resultContent =
    document.getElementById(
        "resultContent"
    );

const taskInput =
    document.getElementById(
        "taskInput"
    );

const taskCounter =
    document.querySelector(
        ".task-counter"
    );

if (taskInput && taskCounter) {

    const updateTaskCounter = () => {

        taskCounter.textContent =
            `${taskInput.value.length} / 500`;

    };

    taskInput.addEventListener(
        "input",
        updateTaskCounter
    );

    updateTaskCounter();
}

if (!captureButton) {

    console.error(
        " Capture button not found."
    );
}


if (!taskInput) {

    console.error(
        " Task input not found."
    );
}


// ============================================================
// AGENT CONFIGURATION
// ============================================================

const API_URL =
    "http://127.0.0.1:8000/analyze";


// Maximum browser actions for one request.
const MAX_AGENT_STEPS = 4;


// Delay after browser action before recapture.
//
// Increased from 150ms to 500ms to reduce the chance of
// Chrome captureVisibleTab quota errors.
const ACTION_SETTLE_DELAY_MS = 500;


// Chrome capture quota retry configuration.
const MAX_CAPTURE_RETRIES = 5;

const CAPTURE_RETRY_DELAY_MS = 500;
// Browser-action retry configuration.
const MAX_ACTION_RETRIES = 2;

const ACTION_RETRY_DELAY_MS = 400;

// ============================================================
// AGENT STATE
// ============================================================

let agentRunning = false;

let completedActions = [];

let totalPlannerLatency = 0;

let totalNetworkLatency = 0;
let currentActionRetryCount = 0;

// ============================================================
// RESULT UI
// ============================================================

function showResult(
    title,
    content,
    success = true
) {

    if (!result) {
        return;
    }


    result.classList.remove(
        "hidden"
    );


    if (resultTitle) {

        resultTitle.textContent =
            title;

        resultTitle.className =
            success
                ? "result-title success"
                : "result-title error";
    }


    if (resultContent) {

        resultContent.innerHTML =
            content;
    }
}


// ============================================================
// LOADING STATE
// ============================================================

function setLoading(
    loading
) {

    agentRunning =
        loading;


    if (!captureButton) {
        return;
    }


    if (loading) {

        captureButton.disabled =
            true;

        captureButton.innerHTML =
            `
                <span class="loading"></span>
                Running Private Agent...
            `;

    } else {

        captureButton.disabled =
            false;

        captureButton.innerHTML =
            `
                 Execute Private Agent
            `;
    }
}


// ============================================================
// GET USER TASK
// ============================================================

function getTask() {

    const task =
        taskInput?.value?.trim() ||
        "";


    return (
        task ||
        "Analyze the page and choose the safest useful action."
    );
}


// ============================================================
// DETECT COMPOUND TYPE + SUBMIT TASK
// ============================================================
//
// Examples:
//
// Fill the Full Name field with "Amit Kumar" and submit
//
// Fill the Full Name field with "Amit Kumar" then submit
//
// Enter "Amit Kumar" in Full Name and submit the form
//
// Type "Amit Kumar" into Full Name, then click submit
//
// ============================================================

function isSubmitCompoundTask(
    task
) {

    const t =
        String(task || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();


    const hasTypeIntent =
        /\b(fill|enter|type|write|input|insert|put)\b/i
            .test(t);


    const hasSubmitIntent =
        /\bsubmit\b/i
            .test(t);


    return (
        hasTypeIntent &&
        hasSubmitIntent
    );
}


// ============================================================
// EXPLICIT VALUE CHECK
// ============================================================
//
// The agent must never obtain a value by reading the webpage.
//
// Example:
//
// Fill Full Name with "Amit Kumar"
//
// contains an explicit value.
//
// ============================================================

function hasExplicitQuotedValue(
    task
) {

    if (!task) {
        return false;
    }


    const patterns = [

        /["“][^"”]+["”]/,

        /['‘][^'’]+['’]/
    ];


    return patterns.some(
        pattern =>
            pattern.test(task)
    );
}


// ============================================================
// VALIDATE COMPOUND TASK
// ============================================================

function validateCompoundTask(
    task
) {

    if (!isSubmitCompoundTask(task)) {

        return {
            valid: true
        };
    }


    if (!hasExplicitQuotedValue(task)) {

        return {

            valid: false,

            message:
                "This task contains a form-fill action, " +
                "but no explicit value was supplied. " +
                "For privacy, the agent will not read or reuse " +
                "a value from the webpage. " +
                "Example: Fill the Full Name field with " +
                "\"Amit Kumar\" and submit the form."
        };
    }


    return {
        valid: true
    };
}


// ============================================================
// LOCAL CAPTURE + SANITIZATION
// ============================================================

async function captureSanitizedScreen() {

    console.log(
        " Requesting local capture + sanitization..."
    );


    const response =
        await chrome.runtime.sendMessage({

            type:
                "CAPTURE_AND_SANITIZE"
        });


    console.log(
    "[PRIVACY] Capture response received:",
    {
        success: response?.success === true,
        sanitizedImage: Boolean(response?.sanitizedImage),
        detectionCount: Array.isArray(response?.detections)
            ? response.detections.length
            : 0,
        domElementCount: Array.isArray(response?.dom_elements)
            ? response.dom_elements.length
            : 0
    }
);


    if (!response) {

        throw new Error(
            "No response received from background service."
        );
    }


    if (!response.success) {

        throw new Error(
            response.error ||
            "Capture and sanitization failed."
        );
    }


    if (!response.sanitizedImage) {

        throw new Error(
            "Sanitized screenshot was not returned."
        );
    }


    console.log(
        " Sanitized screenshot received."
    );


    console.log(
        " Local PII detections:",
        response.detections?.length || 0
    );


    console.log(
        " Safe DOM elements:",
        response.dom_elements?.length || 0
    );


    return response;
}


// ============================================================
// EXECUTE ONE BROWSER ACTION
// ============================================================

async function executeAction(
    action
) {

    console.log(
    "[ACTION] Sending browser action:",
    {
        action:
            action?.action ||
            action?.type ||
            "none",

        confidence:
            Number(
                action?.confidence || 0
            ),

        valueLength:
            (
                action?.action === "type" ||
                action?.type === "type"
            )
                ? String(
                    action?.text ??
                    action?.value ??
                    ""
                ).length
                : undefined
    }
);


    if (!action) {

        return {
            success: false,
            error:
                "No browser action was returned."
        };
    }


    const response =
        await chrome.runtime.sendMessage({

            type:
                "EXECUTE_BROWSER_ACTION",

            action:
                action
        });


    console.log(
    "[ACTION] Execution response:",
    {
        success:
            response?.success === true,

        action:
            response?.result?.action ||
            response?.action ||
            "unknown",

        error:
            response?.error ||
            response?.result?.error ||
            undefined
    }
);


    return response;
}


// ============================================================
// WAIT FOR DOM / INPUT TO SETTLE
// ============================================================

async function waitForActionToSettle() {

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                ACTION_SETTLE_DELAY_MS
            )
    );
}


// ============================================================
// CHECK CHROME CAPTURE QUOTA ERROR
// ============================================================

function isCaptureQuotaError(
    error
) {

    const message =
        String(
            error?.message ||
            error ||
            ""
        )
            .toLowerCase();


    return (
        message.includes(
            "max_capture_visible_tab_calls_per_second"
        ) ||
        message.includes(
            "exceeds the max_capture"
        ) ||
        (
            message.includes(
                "capturevisibletab"
            ) &&
            message.includes(
                "quota"
            )
        ) ||
        message.includes(
            "quota"
        )
    );
}


// ============================================================
// FINAL / POST-ACTION SANITIZED CAPTURE
// ============================================================
//
// Chrome limits captureVisibleTab() calls per second.
//
// This function retries quota failures instead of immediately
// failing the agent.
//
// ============================================================

async function captureFinalState() {

    console.log(
        " Capturing final/new sanitized page state..."
    );


    let lastError = null;


    for (
        let attempt = 1;
        attempt <= MAX_CAPTURE_RETRIES;
        attempt++
    ) {

        try {

            console.log(
                ` Capture attempt ${attempt}/${MAX_CAPTURE_RETRIES}`
            );


            const finalCapture =
                await captureSanitizedScreen();


            console.log(
                " New sanitized screenshot captured."
            );


            return finalCapture;

        } catch (error) {

            lastError =
                error;


            if (
                !isCaptureQuotaError(
                    error
                )
            ) {

                throw error;
            }


            console.warn(
                ` Chrome capture quota hit on attempt ${attempt}.`
            );


            if (
                attempt <
                MAX_CAPTURE_RETRIES
            ) {

                console.log(
                    ` Waiting ${CAPTURE_RETRY_DELAY_MS} ms before retry...`
                );


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            CAPTURE_RETRY_DELAY_MS
                        )
                );
            }
        }
    }


    throw new Error(
        lastError?.message ||
        "Could not capture sanitized screen after retries."
    );
}
function sanitizeDomLabel(label) {
    const text =
        String(label || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);

    if (!text) {
        return "";
    }

    // Do not transmit obvious sensitive values.
    const sensitivePatterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/,
    /\b\d{4}\s?\d{4}\s?\d{4}\b/,
    /\b[A-Z]{5}\d{4}[A-Z]\b/i,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b(?:otp|one[-\s]?time[-\s]?password)\b/i,
    /\b(?:password|passwd|passcode|pin|credential|secret)\b/i
];

    for (const pattern of sensitivePatterns) {
        if (pattern.test(text)) {
            return "";
        }
    }

    return text;
}
// ============================================================
// FINAL PRIVACY PAYLOAD GATE
// ============================================================
//
// This is the final client-side security boundary before
// anything is transmitted to FastAPI.
//
// Rules:
// - Screenshot must be sanitized.
// - Detection values are forbidden.
// - DOM values are forbidden.
// - Password / OTP / credential data are forbidden.
// - URL query parameters and fragments are forbidden.
// - Only safe metadata is allowed.
// ============================================================

function buildPrivacySafePayload(
    captureResponse,
    task
) {
    if (
        !captureResponse ||
        typeof captureResponse !== "object"
    ) {
        throw new Error(
            "Invalid capture response."
        );
    }

    const sanitizedImage =
        captureResponse.sanitizedImage;

    if (
        typeof sanitizedImage !== "string" ||
        !sanitizedImage.startsWith(
            "data:image/"
        )
    ) {
        throw new Error(
            "Privacy gate blocked transmission: " +
            "sanitized screenshot is missing."
        );
    }

    // --------------------------------------------------------
    // DETECTIONS
    // --------------------------------------------------------

    const rawDetections =
        Array.isArray(
            captureResponse.detections
        )
            ? captureResponse.detections
            : [];

    const safeDetections =
        rawDetections.map(
            (detection, index) => {

                if (
                    !detection ||
                    typeof detection !== "object"
                ) {
                    throw new Error(
                        `Privacy gate blocked detection ${index}.`
                    );
                }

                // Existing detected values must NEVER
                // cross the privacy boundary.
                if (
                    Object.prototype.hasOwnProperty.call(
                        detection,
                        "value"
                    )
                ) {
                    throw new Error(
                        "Privacy gate blocked transmission: " +
                        "PII value found in detection metadata."
                    );
                }

                return {
                    id:
                        detection.id ??
                        index,

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

                    rect:
                        detection.rect &&
                        typeof detection.rect === "object"
                            ? {
                                left:
                                    Number(
                                        detection.rect.left || 0
                                    ),

                                top:
                                    Number(
                                        detection.rect.top || 0
                                    ),

                                right:
                                    Number(
                                        detection.rect.right || 0
                                    ),

                                bottom:
                                    Number(
                                        detection.rect.bottom || 0
                                    ),

                                width:
                                    Number(
                                        detection.rect.width || 0
                                    ),

                                height:
                                    Number(
                                        detection.rect.height || 0
                                    )
                            }
                            : undefined
                };
            }
        );

    // --------------------------------------------------------
    // DOM METADATA
    // --------------------------------------------------------

    const rawDomElements =
        Array.isArray(
            captureResponse.dom_elements
        )
            ? captureResponse.dom_elements
            : [];

    const FORBIDDEN_KEYS = new Set([
        "value",
        "inputValue",
        "input_value",
        "password",
        "otp",
        "secret",
        "credential",
        "credentials",
        "innerValue",
        "rawValue",
        "fieldValue"
    ]);

    const safeDomElements =
        rawDomElements.map(
            (element, index) => {

                if (
                    !element ||
                    typeof element !== "object"
                ) {
                    throw new Error(
                        `Privacy gate blocked DOM element ${index}.`
                    );
                }

                for (
                    const key of Object.keys(element)
                ) {
                    if (
                        FORBIDDEN_KEYS.has(
                            key
                        )
                    ) {
                        throw new Error(
                            "Privacy gate blocked transmission: " +
                            `sensitive DOM property "${key}" detected.`
                        );
                    }
                }

                return {
    index,

    tag:
        String(
            element.tag ||
            element.tagName ||
            ""
        ),

    type:
        String(
            element.type || ""
        ),

    role:
        String(
            element.role || ""
        ),

    // Only retain semantic metadata.
    // Never transmit arbitrary DOM text.
   label:
    element.is_button
        ? sanitizeDomLabel(
            element.label
        )
        : "",

    x:
        Number(
            element.x || 0
        ),

    y:
        Number(
            element.y || 0
        ),

    width:
        Number(
            element.width || 0
        ),

    height:
        Number(
            element.height || 0
        ),

    in_viewport:
        Boolean(
            element.in_viewport
        ),

    is_button:
        Boolean(
            element.is_button
        )
};
            }
        );

   

// --------------------------------------------------------
// PAGE URL
// --------------------------------------------------------

const rawPageUrl =
    String(
        captureResponse.page_url || ""
    );

let safePageUrl = "";

try {
    const parsedUrl =
        new URL(rawPageUrl);

    // Never transmit query parameters or fragments.
    // Only the origin is required for planner context.
    safePageUrl =
        parsedUrl.origin;

} catch (_) {
    safePageUrl = "";
}

    // --------------------------------------------------------
    // VIEWPORT
    // --------------------------------------------------------

    const rawViewport =
        captureResponse.viewport;

    const safeViewport =
        rawViewport &&
        typeof rawViewport === "object"
            ? {
                width:
                    Number(
                        rawViewport.width || 0
                    ),

                height:
                    Number(
                        rawViewport.height || 0
                    ),

                devicePixelRatio:
                    Number(
                        rawViewport.devicePixelRatio || 1
                    )
            }
            : null;

    // --------------------------------------------------------
    // TASK
    // --------------------------------------------------------
    //
    // The task is intentionally preserved because the user
    // may explicitly provide a value to type.
    //
    // Example:
    // Fill Full Name with "Amit Kumar"
    //
    // This is user-provided instruction, NOT webpage-derived
    // PII.
    // --------------------------------------------------------

    const safeTask =
        String(task || "").trim();

    // --------------------------------------------------------
    // FINAL PAYLOAD
    // --------------------------------------------------------

    return {
        screenshot:
            sanitizedImage,

        detections:
            safeDetections,

        page_url:
            safePageUrl,

        dom_elements:
            safeDomElements,

        viewport:
            safeViewport,

        task:
            safeTask
    };
}
// ============================================================
// API — ANALYZE SANITIZED CONTEXT
// ============================================================

async function analyzeSanitizedContext(
    captureResponse,
    task
) {

    const sanitizedImage =
        captureResponse.sanitizedImage;


    const detections =
        captureResponse.detections ||
        [];


    const domElements =
        captureResponse.dom_elements ||
        [];


    const pageUrl =
        captureResponse.page_url ||
        "";


    const viewport =
        captureResponse.viewport ||
        null;


    console.log();

    console.log(
        "=========================================="
    );

    console.log(
        "[PRIVATE AGENT → FASTAPI]"
    );

    console.log(
        "=========================================="
    );


    console.log(
        " Screenshot:",
        sanitizedImage
            ? "SANITIZED"
            : "MISSING"
    );


    console.log(
        " PII detections:",
        detections.length
    );


    console.log(
        " Safe DOM elements:",
        domElements.length
    );


    console.log(
    "[PLANNER] Task prepared:",
    {
        length: String(task || "").length,
hasExplicitValue:
    hasExplicitQuotedValue(task)
    }
);


    console.log(
    "[PLANNER] Page context available:",
    Boolean(pageUrl)
);


    console.log(
        "=========================================="
    );


    const startTime =
        performance.now();


    // ========================================================
    // IMPORTANT PRIVACY BOUNDARY
    //
    // Only sanitizedImage is transmitted.
    //
    // No raw screenshot is sent.
    // ========================================================

    // ========================================================
// FINAL PRIVACY GATE
// ========================================================
//
// Nothing reaches FastAPI until the payload passes the
// client-side privacy validation.
// ========================================================

const privacySafePayload =
    buildPrivacySafePayload(
        captureResponse,
        task
    );

console.log(
    "[PRIVACY] Final transmission gate approved:",
    {
        sanitizedScreenshot:
            Boolean(
                privacySafePayload.screenshot
            ),

        detectionCount:
            privacySafePayload
                .detections
                .length,

        domElementCount:
            privacySafePayload
                .dom_elements
                .length,

        pageUrl:
            privacySafePayload.page_url,

        taskPresent:
            Boolean(
                privacySafePayload.task
            )
    }
);

const response =
    await fetch(
        API_URL,
        {
            method:
                "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body:
                JSON.stringify(
                    privacySafePayload
                )
        }
    );


    const networkLatency =
        performance.now() -
        startTime;


    totalNetworkLatency +=
        networkLatency;


    console.log(
        ` Network latency: ${networkLatency.toFixed(2)} ms`
    );


    if (!response.ok) {

        throw new Error(
            `FastAPI returned HTTP ${response.status}`
        );
    }


    const data =
        await response.json();


    console.log(
    "[PLANNER] Response received:",
    {
        success:
            data?.success === true,

        action:
            data?.action?.action ||
            data?.action?.type ||
            "none",

        confidence:
            Number(
                data?.action?.confidence || 0
            ),

        plannerLatency:
            Number(
                data?.vlm_latency_ms ||
                data?.processing_time_ms ||
                0
            )
    }
);


    if (!data.success) {

        throw new Error(
            data.error ||
            "AI analysis failed."
        );
    }


    const action =
        data.action ||
        {};


    const actionType =
        action.action ||
        action.type ||
        "none";


    const confidence =
        action.confidence ??
        0;


    const reason =
        action.reason ||
        "No reason provided";


    const plannerLatency =
        Number(
            data.vlm_latency_ms ||
            data.processing_time_ms ||
            0
        );


    totalPlannerLatency +=
        plannerLatency;


    return {

        data,

        action,

        actionType,

        confidence,

        reason,

        plannerLatency,

        networkLatency,

        detections,

        domElements,

        pageUrl,

        viewport,

        sanitizedImage
    };
}


// ============================================================
// ACTION LABEL
// ============================================================

function actionLabel(
    actionType
) {

    const labels = {

        type:
            "TYPE",

        click:
            "CLICK",

        scroll:
            "SCROLL",

        wait:
            "WAIT",

        none:
            "NONE"
    };


    return (
        labels[actionType] ||
        String(
            actionType ||
            "UNKNOWN"
        ).toUpperCase()
    );
}


// ============================================================
// ACTION DESCRIPTION
// ============================================================

function describeAction(
    action
) {

    const type =
        action?.action ||
        action?.type ||
        "none";


    if (type === "type") {

        return (
            `TYPE value of length ` +
            `${String(
                action?.text || ""
            ).length}`
        );
    }


    if (type === "click") {

        return (
            `CLICK at (` +
            `${action?.x ?? 0}, ` +
            `${action?.y ?? 0})`
        );
    }


    if (type === "scroll") {

        return (
            `SCROLL ` +
            `${action?.amount ?? 0}px`
        );
    }


    if (type === "wait") {

        return "WAIT";
    }


    return "NO ACTION";
}


// ============================================================
// ACTION HISTORY
// ============================================================

function renderActionHistory() {

    if (
        !completedActions ||
        completedActions.length === 0
    ) {

        return "";
    }


    const rows =
        completedActions
            .map(
                (item, index) => {

                    return `
                        <div class="row">
                            <span class="label">
                                Step ${index + 1}:
                            </span>

                            ${escapeHTML(
                                item.description
                            )}

                            <span class="success status-success">
                                Successful
                            </span>
                        </div>
                    `;
                }
            )
            .join("");


    return `
        <div class="state-title">
            AGENT ACTION HISTORY
        </div>

        ${rows}
    `;
}


// ============================================================
// SHOW NO ACTION
// ============================================================

function showNoActionResult(
    task,
    analysis,
    image
) {

    const {
        actionType,
        confidence,
        reason,
        plannerLatency,
        detections
    } = analysis;


    showResult(

        " Agent completed",

        `
            <div class="row">
                <span class="label">
                    Task:
                </span>

                ${escapeHTML(task)}
            </div>

            <div class="row">
                <span class="label">
                    Action:
                </span>

                ${escapeHTML(
                    actionLabel(
                        actionType
                    )
                )}
            </div>

            <div class="row">
                <span class="label">
                    Confidence:
                </span>

                ${confidence}
            </div>

            <div class="row">
    <span class="label">
        Planner status:
    </span>

    <span class="status-success">
        Safe action selected
    </span>
</div>

            <div class="row">
                <span class="label">
                    Planner latency:
                </span>

                ${Number(
                    plannerLatency
                ).toFixed(2)} ms
            </div>

            <div class="row">
                <span class="label">
                    PII detections:
                </span>

                ${detections.length}
            </div>

            ${renderActionHistory()}

            <img
                class="preview"
                src="${image}"
                alt="Sanitized screenshot"
            />

            <div class="small">
                 Screenshot sanitized locally.
                No raw screenshot was sent to the AI.
            </div>
        `,

        true
    );
}


// ============================================================
// SHOW EXECUTION FAILURE
// ============================================================

function showExecutionFailure(
    task,
    analysis,
    image,
    executionResponse
) {

    const {
        actionType,
        confidence,
        reason,
        plannerLatency,
        detections
    } = analysis;


    const errorMessage =
        executionResponse?.error ||
        executionResponse?.result?.error ||
        "Unknown browser execution error.";


    showResult(

        " Agent Action Failed",

        `
            <div class="row">
                <span class="label">
                    Task:
                </span>

                ${escapeHTML(task)}
            </div>

            <div class="row">
                <span class="label">
                    Action:
                </span>

                ${escapeHTML(
                    actionLabel(
                        actionType
                    )
                )}
            </div>

            <div class="row">
                <span class="label">
                    Confidence:
                </span>

                ${confidence}
            </div>

            <div class="row">
    <span class="label">
        Planner status:
    </span>

    <span class="status-error">
        Action execution failed
    </span>
</div>
            <div class="row error">
                Execution:  Failed
            </div>

            <div class="row error">
                ${escapeHTML(errorMessage)}
            </div>

            <div class="row">
                <span class="label">
                    Planner latency:
                </span>

                ${Number(
                    plannerLatency
                ).toFixed(2)} ms
            </div>

            <div class="row">
                <span class="label">
                    PII detections:
                </span>

                ${detections.length}
            </div>

            ${renderActionHistory()}

            <img
                class="preview"
                src="${image}"
                alt="Sanitized screenshot"
            />

            <div class="small">
                 Raw screenshot was not sent to the AI.
            </div>
        `,

        false
    );
}


// ============================================================
// SHOW FINAL SUCCESS
// ============================================================

function showAgentCompleted(
    task,
    finalCapture,
    totalLatency
) {

    const finalImage =
        finalCapture?.sanitizedImage ||
        "";


    const finalDetections =
        finalCapture?.detections ||
        [];


    const stepCount =
        completedActions.length;


    const history =
        completedActions
            .map(
                (item, index) => {

                    return `
                        <div class="row">
                            <span class="label">
                                Step ${index + 1}:
                            </span>

                            ${escapeHTML(
                                item.description
                            )}

                            <span class="success">
                                 Successful
                            </span>
                        </div>
                    `;
                }
            )
            .join("");


    showResult(

        " Private Agent Completed",

        `
            <div class="privacy-badge">
                 SANITIZED BEFORE EVERY AI STEP
            </div>

            <div class="row">
                <span class="label">
                    Task:
                </span>

                ${escapeHTML(task)}
            </div>

            <div class="row">
                <span class="label">
                    Steps completed:
                </span>

                ${stepCount}
            </div>

            <div class="state-title">
                AGENT ACTION HISTORY
            </div>

            ${history}

            <div class="row">
                <span class="label">
                    Total planner latency:
                </span>

                ${Number(
                    totalPlannerLatency
                ).toFixed(2)} ms
            </div>

            <div class="row">
                <span class="label">
                    Total network latency:
                </span>

                ${Number(
                    totalNetworkLatency
                ).toFixed(2)} ms
            </div>

            <div class="row">
                <span class="label">
                    Total agent latency:
                </span>

                ${Number(
                    totalLatency
                ).toFixed(2)} ms
            </div>

            <div class="row">
                <span class="label">
                    Final PII detections:
                </span>

                ${finalDetections.length}
            </div>

            <div class="state-title">
                FINAL STATE — SANITIZED
            </div>

            ${
                finalImage
                    ? `
                        <img
                            class="preview"
                            src="${finalImage}"
                            alt="Final sanitized screenshot"
                        />
                    `
                    : ""
            }

            <div class="small">
                 Sensitive pixels are redacted locally.
                The AI receives only sanitized visual context.
            </div>
        `,

        true
    );
}


// ============================================================
// SHOW STEP PROGRESS
// ============================================================

function showProgress(
    task,
    stepNumber,
    actionType,
    confidence,
    reason,
    detections
) {

    showResult(

        ` Agent Step ${stepNumber}`,

        `
            <div class="privacy-badge">
                 SANITIZED BEFORE AI
            </div>

            <div class="row">
                <span class="label">
                    Task:
                </span>

                ${escapeHTML(task)}
            </div>

            <div class="row">
                <span class="label">
                    Current action:
                </span>

                ${escapeHTML(
                    actionLabel(
                        actionType
                    )
                )}
            </div>

            <div class="row">
                <span class="label">
                    Confidence:
                </span>

                ${confidence}
            </div>

            <div class="row">
    <span class="label">
        Planner status:
    </span>

    <span class="status-success">
        Safe action selected
    </span>
</div>

            <div class="row">
                <span class="label">
                    PII detections:
                </span>

                ${detections.length}
            </div>

            ${renderActionHistory()}

            <div class="small">
                 Executing step ${stepNumber}...
            </div>
        `,

        true
    );
}


// ============================================================
// MAIN MULTI-STEP AGENT PIPELINE
// ============================================================
function isRetryableActionFailure(response) {

    if (
        !response ||
        typeof response !== "object"
    ) {
        return false;
    }

    // Unsafe failures are always terminal.
    if (
        response.unsafe === true
    ) {
        return false;
    }

    return (
        response.retryable === true
    );
}


function getExecutionError(response) {

    return (
        response?.error ||
        response?.result?.error ||
        "Unknown browser execution error."
    );
}


async function retryFailedAction(
    analysis,
    executionResponse,
    retryNumber,
    currentCaptureRef
) {

    console.warn(
        `[RETRY] Action failed. Retrying ${retryNumber}/${MAX_ACTION_RETRIES}.`
    );

    console.warn(
        "[RETRY] Failure reason:",
        getExecutionError(
            executionResponse
        )
    );


    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                ACTION_RETRY_DELAY_MS
            )
    );


    try {

        console.log(
            "[RETRY] Capturing a fresh sanitized state before re-planning."
        );


        const freshCapture =
            await captureFinalState();


        currentCaptureRef.value =
            freshCapture;


        console.log(
            "[RETRY] Fresh sanitized state captured."
        );


        console.log(
            `[RETRY] Re-planning failed ${analysis.actionType} action.`
        );


        return true;

    } catch (captureError) {

        console.error(
            "[RETRY] Fresh sanitized capture failed. Retry aborted safely:",
            captureError?.message ||
            captureError
        );


        return false;
    }
}

async function captureAndAnalyze() {

    if (agentRunning) {

        console.log(
            " Agent is already running."
        );

        return;
    }


    // ========================================================
    // RESET STATE
    // ========================================================

    const overallStart =
        performance.now();


    completedActions = [];


    totalPlannerLatency = 0;


    totalNetworkLatency = 0;
currentActionRetryCount = 0;

    setLoading(true);


    if (result) {

        result.classList.add(
            "hidden"
        );
    }


    try {

        // ====================================================
        // STEP 0 — READ USER TASK
        // ====================================================

        const originalTask =
            getTask();


        console.log();

        console.log(
            "=========================================="
        );

        console.log(
            "[PRIVATE AGENT START]"
        );

        console.log(
            "=========================================="
        );


        console.log(
    "[AGENT] User task received:",
    {
        length:
            originalTask.length,
        hasExplicitValue:
            hasExplicitQuotedValue(
                originalTask
            )
    }
);


        // ====================================================
        // SAFETY VALIDATION
        // ====================================================

        const validation =
            validateCompoundTask(
                originalTask
            );


        if (!validation.valid) {

            showResult(

                " Explicit value required",

                `
                    <div class="row error">
                        ${escapeHTML(
                            validation.message
                        )}
                    </div>

                    <div class="small">
                        The agent will never extract or
                        reconstruct a sensitive value from
                        the webpage for a typing action.
                    </div>
                `,

                false
            );


            return;
        }


        // ====================================================
        // DETERMINE TASK TYPE
        // ====================================================

        const compoundTask =
            isSubmitCompoundTask(
                originalTask
            );


        console.log(
            " Compound task:",
            compoundTask
        );


        // ====================================================
        // CURRENT PLANNER TASK
        // ====================================================

        let currentTask =
            originalTask;


        // ====================================================
        // INITIAL SANITIZED CAPTURE
        // ====================================================

        let currentCapture =
            await captureSanitizedScreen();


        // Most recent valid sanitized state.
        //
        // This is important because if Chrome temporarily
        // blocks another capture after an action, we can
        // still safely display the previous sanitized state.

        let finalCapture =
            currentCapture;


        // ====================================================
        // AGENT LOOP
        // ====================================================

        for (
            let step = 1;
            step <= MAX_AGENT_STEPS;
            step++
        ) {

            console.log();

            console.log(
                "=========================================="
            );

            console.log(
                `[AGENT STEP ${step}]`
            );

            console.log(
                "=========================================="
            );


            console.log(
    "[PLANNER] Task prepared:",
    {
        length: String(currentTask || "").length,
        hasExplicitValue:
            hasExplicitQuotedValue(currentTask)
    }
);


            // =================================================
            // PLAN CURRENT ACTION
            // =================================================

            const analysis =
                await analyzeSanitizedContext(
                    currentCapture,
                    currentTask
                );


            console.log(
                " Action:",
                analysis.actionType
            );


            console.log(
                " Confidence:",
                analysis.confidence
            );


            console.log(
    "[PLANNER] Reason received."
);


            // =================================================
            // NO ACTION
            // =================================================

            if (
                analysis.actionType ===
                "none"
            ) {

                console.log(
                    " Planner returned no safe action."
                );


                if (
                    completedActions.length > 0
                ) {

                    showAgentCompleted(

                        originalTask,

                        finalCapture,

                        performance.now() -
                        overallStart
                    );

                } else {

                    showNoActionResult(

                        originalTask,

                        analysis,

                        currentCapture.sanitizedImage
                    );
                }


                return;
            }


            // =================================================
            // SHOW PROGRESS
            // =================================================

            showProgress(

                originalTask,

                step,

                analysis.actionType,

                analysis.confidence,

                analysis.reason,

                analysis.detections
            );


            // =================================================
            // EXECUTE ACTION
            // =================================================

            console.log(
                ` Executing step ${step}:`,
                describeAction(
                    analysis.action
                )
            );


            const executionResponse =
                await executeAction(
                    analysis.action
                );


            console.log(
    "[ACTION] Execution response:",
    {
        success:
            executionResponse?.success === true,

        action:
            executionResponse?.result?.action ||
            executionResponse?.action ||
            "unknown",

        error:
            executionResponse?.error ||
            executionResponse?.result?.error ||
            undefined
    }
);


            const executionSuccess =
                Boolean(
                    executionResponse?.success
                );


                       // =================================================
            // EXECUTION FAILURE
            // =================================================

            if (!executionSuccess) {

                const retryable =
                    isRetryableActionFailure(
                        executionResponse
                    );

                const unsafeFailure =
                    executionResponse?.unsafe === true;

                const errorMessage =
                    getExecutionError(
                        executionResponse
                    );

                console.error(
                    "[ACTION] Browser action failed:",
                    {
                        success: false,

                        action:
                            executionResponse?.result?.action ||
                            executionResponse?.action ||
                            "unknown",

                        retryable,

                        unsafe:
                            unsafeFailure,

                        retryCount:
                            currentActionRetryCount,

                        error:
                            errorMessage
                    }
                );


                // =================================================
                // RETRY TRANSIENT FAILURE
                // =================================================

                if (
                    retryable &&
                    !unsafeFailure &&
                    currentActionRetryCount <
                        MAX_ACTION_RETRIES
                ) {

                    currentActionRetryCount += 1;


                    const retryState = {
                        value:
                            currentCapture
                    };


                    showResult(
                        "Retrying Browser Action",

                        `
                            <div class="privacy-badge">
                                SANITIZED BEFORE RETRY
                            </div>

                            <div class="row">
                                <span class="label">
                                    Task:
                                </span>

                                ${escapeHTML(
                                    originalTask
                                )}
                            </div>

                            <div class="row">
                                <span class="label">
                                    Action:
                                </span>

                                ${escapeHTML(
                                    actionLabel(
                                        analysis.actionType
                                    )
                                )}
                            </div>

                            <div class="row">
                                <span class="label">
                                    Retry:
                                </span>

                                ${currentActionRetryCount}/${MAX_ACTION_RETRIES}
                            </div>

                            <div class="row error">
                                ${escapeHTML(
                                    errorMessage
                                )}
                            </div>

                            <div class="small">
                                A fresh sanitized page state will be captured and the action will be re-planned.
                            </div>
                        `,

                        true
                    );


                    const retryPrepared =
                        await retryFailedAction(
                            analysis,
                            executionResponse,
                            currentActionRetryCount,
                            retryState
                        );


                    if (
                        retryPrepared
                    ) {

                        currentCapture =
                            retryState.value;

                        console.log(
                            "[RETRY] Continuing agent loop with fresh state."
                        );

                        continue;
                    }
                }


                // =================================================
                // TERMINAL FAILURE
                // =================================================

                if (
                    unsafeFailure
                ) {

                    console.warn(
                        "[SAFETY] Unsafe action failure is terminal. No retry performed."
                    );

                } else {

                    console.warn(
                        "[RETRY] Retry limit reached or failure is not retryable. Stopping safely."
                    );
                }


                showExecutionFailure(
                    originalTask,
                    analysis,
                    currentCapture.sanitizedImage,
                    executionResponse
                );

                    return;
}


// =================================================
// SUCCESSFUL ACTION
// =================================================

currentActionRetryCount = 0;


// =================================================
// RECORD SUCCESSFUL ACTION
// =================================================

completedActions.push({
    action:
        analysis.actionType,

    description:
        describeAction(
            analysis.action
        ),

    confidence:
        analysis.confidence,

    plannerLatency:
        analysis.plannerLatency,

    networkLatency:
        analysis.networkLatency
});


console.log(
    `Step ${step} executed successfully.`
);


console.log(
    "Completed actions:",
    completedActions.length
);
           

            // =================================================
            // FINAL COMPOUND ACTION
            // =================================================
            //
            // If this is the CLICK SUBMIT step, the requested
            // browser task is already complete.
            //
            // Do NOT make another planner request.
            //
            // We only TRY to capture a final sanitized state.
            // If Chrome's screenshot quota is temporarily hit,
            // we keep the last valid sanitized screenshot.
            //
            // =================================================

            if (
                compoundTask &&
                analysis.actionType === "click" &&
                /\bsubmit\b/i.test(
                    currentTask
                )
            ) {

                console.log();

                console.log(
                    "=========================================="
                );

                console.log(
                    " COMPOUND TASK COMPLETED"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    " TYPE step completed."
                );


                console.log(
                    " CLICK SUBMIT step completed."
                );


                console.log(
                    " All requested browser actions executed successfully."
                );


                // ------------------------------------------------
                // TRY FINAL SANITIZED CAPTURE
                // ------------------------------------------------

                await waitForActionToSettle();


                try {

                    finalCapture =
                        await captureFinalState();


                    console.log(
                        " Final sanitized state captured."
                    );

                } catch (finalCaptureError) {

                    console.warn(
                        " Final sanitized capture unavailable:"
                    );


                    console.warn(
                        finalCaptureError
                    );


                    console.log(
                        " Keeping previous valid sanitized state."
                    );
                }


                showAgentCompleted(

                    originalTask,

                    finalCapture,

                    performance.now() -
                    overallStart
                );


                return;
            }


            // =================================================
            // CAPTURE NEW SANITIZED STATE
            // =================================================
            //
            // For non-final actions, a fresh state is required
            // before the next planner step.
            //
            // =================================================

            console.log(
                "Capturing NEW state after action..."
            );


            try {

                finalCapture =
                    await captureFinalState();

            } catch (captureError) {

                console.error(
                    "Post-action capture failed:",
                    captureError
                );


                showResult(

                    "Action executed, but recapture failed",

                    `
                        <div class="row">
                            <span class="label">
                                Task:
                            </span>

                            ${escapeHTML(
                                originalTask
                            )}
                        </div>

                        <div class="row">
                            <span class="label">
                                Completed steps:
                            </span>

                            ${completedActions.length}
                        </div>

                        ${renderActionHistory()}

                        <div class="row success">
                            Last action:
                             Executed
                        </div>

                        <div class="row error">
                            Recapture failed:
                            ${escapeHTML(
                                captureError.message
                            )}
                        </div>

                        <div class="small">
                            The browser action itself succeeded.
                            The next agent step was stopped safely
                            because a fresh sanitized state could
                            not be obtained.
                        </div>
                    `,

                    false
                );


                return;
            }


            // =================================================
            // IMPORTANT:
            //
            // The newly captured state is now the state the
            // planner must reason over.
            // =================================================

            currentCapture =
                finalCapture;


            // =================================================
            // COMPOUND TASK — TYPE → CLICK SUBMIT
            // =================================================
            //
            // After TYPE, switch planner task from the original
            // compound instruction to the explicit remaining
            // action: Click Submit.
            //
            // =================================================

            if (
                compoundTask &&
                analysis.actionType === "type"
            ) {

                console.log();

                console.log(
                    "=========================================="
                );

                console.log(
                    " COMPOUND TASK CONTINUATION"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    " TYPE step completed."
                );


                console.log(
                    " Next required action: CLICK SUBMIT"
                );


                // ---------------------------------------------
                // IMPORTANT
                //
                // The original compound task is not sent again.
                //
                // ---------------------------------------------

                currentTask =
                    "Click Submit";


                // ---------------------------------------------
                // finalCapture is already a NEW sanitized
                // screenshot captured after TYPE.
                // ---------------------------------------------

                currentCapture =
                    finalCapture;


                console.log(
                    " Next planner task:",
                    currentTask
                );


                console.log(
                    " Fresh sanitized state assigned."
                );


                console.log(
                    " Continuing to next planner step..."
                );


                console.log(
                    "=========================================="
                );


                // ---------------------------------------------
                // CONTINUE LOOP
                // ---------------------------------------------

                continue;
            }


            // =================================================
            // COMPOUND TASK — SCROLL CONTINUATION
            // =================================================
            //
            // THIS IS THE IMPORTANT FIX.
            //
            // If the Submit button is off-screen, the planner
            // returns SCROLL.
            //
            // SCROLL IS NOT THE END OF A COMPOUND TASK.
            //
            // The fresh sanitized screenshot above contains the
            // newly visible page state. We must continue the loop
            // so the planner can now see and click Submit.
            //
            // =================================================

            if (
                compoundTask &&
                analysis.actionType === "scroll"
            ) {

                console.log();

                console.log(
                    "=========================================="
                );

                console.log(
                    " COMPOUND TASK SCROLL CONTINUATION"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    " SCROLL step completed."
                );


                console.log(
                    " Re-planning after scroll..."
                );


                // finalCapture is the fresh sanitized state
                // captured after the scroll action.

                currentCapture =
                    finalCapture;


                console.log(
                    " Fresh sanitized state assigned after scroll."
                );


                console.log(
                    " Next planner task:",
                    currentTask
                );


                console.log(
                    " Continuing to next planner step..."
                );


                console.log(
                    "=========================================="
                );


                // IMPORTANT:
                //
                // Do NOT show completion here.
                //
                // Continue to the next loop iteration so
                // "Click Submit" is planned and executed.

                continue;
            }


            // =================================================
            // SINGLE ACTION TASK
            // =================================================

            console.log(
                " Single-step task completed."
            );


            showAgentCompleted(

                originalTask,

                finalCapture,

                performance.now() -
                overallStart
            );


            return;
        }


        // ====================================================
        // MAX STEPS REACHED
        // ====================================================

        showResult(

            "Agent stopped safely",

            `
                <div class="row">
                    <span class="label">
                        Task:
                    </span>

                    ${escapeHTML(
                        originalTask
                    )}
                </div>

                <div class="row">
                    <span class="label">
                        Completed steps:
                    </span>

                    ${completedActions.length}
                </div>

                ${renderActionHistory()}

                <div class="row error">
                    Maximum agent steps reached.
                </div>

                <div class="small">
                    The agent stopped instead of continuing
                    indefinitely.
                </div>
            `,

            false
        );


    } catch (error) {

        console.error(
    "[AGENT] Pipeline failed:",
    {
        message:
            error?.message ||
            "Unknown pipeline error"
    }
);


        showResult(

            " Pipeline Error",

            `
                <div class="row error">
                    ${escapeHTML(
                        error?.message ||
                        String(error)
                    )}
                </div>

                ${renderActionHistory()}

                <div class="small">
                    Open the extension service-worker
                    console for detailed logs.
                </div>
            `,

            false
        );


    } finally {

        setLoading(false);


        console.log();

        console.log(
            "=========================================="
        );

        console.log(
            "[PRIVATE AGENT FINISHED]"
        );

        console.log(
            "=========================================="
        );


        console.log(
    "[AGENT] Completed actions:",
    completedActions.length
);


        console.log(
            "Total planner latency:",
            totalPlannerLatency.toFixed(2),
            "ms"
        );


        console.log(
            "Total network latency:",
            totalNetworkLatency.toFixed(2),
            "ms"
        );
    }
}


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHTML(
    value
) {

    return String(
        value ?? ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


// ============================================================
// QUICK TASK BUTTONS
// ============================================================

const quickTasks = {

    "Full Name":
        "Click the Full Name field",

    "Email":
        "Click the Email field",

    "Phone":
        "Click the Phone field",

    "Submit":
        "Click Submit",

    "Scroll Down":
        "Scroll down"
};


Object.entries(
    quickTasks
)
.forEach(
    ([label, task]) => {

        const buttons =
            document.querySelectorAll(
                "button"
            );


        buttons.forEach(
            button => {

                if (
                    button.textContent
                        ?.trim() ===
                    label
                ) {

                    button.addEventListener(
                        "click",
                        () => {

                            if (
                                taskInput
                            ) {

                                taskInput.value =
                                    task;

                                taskInput.focus();
                            }
                        }
                    );
                }
            }
        );
    }
);


// ============================================================
// ENTER KEY
// ============================================================

if (taskInput) {

    taskInput.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Enter" &&
                !event.shiftKey
            ) {

                event.preventDefault();

                captureAndAnalyze();
            }
        }
    );
}


// ============================================================
// MAIN BUTTON
// ============================================================

if (captureButton) {

    captureButton.addEventListener(
        "click",
        captureAndAnalyze
    );
}


// ============================================================
// INITIAL LOG
// ============================================================

console.log(
    " Private Agent popup listeners attached"
);


console.log(
    " Multi-step private agent enabled"
);


console.log(
    " Screenshot-only PII masking enabled"
);


console.log(
    " Compound TYPE → SUBMIT flow enabled"
);


console.log(
    " Compound SCROLL → CONTINUE flow enabled"
);
