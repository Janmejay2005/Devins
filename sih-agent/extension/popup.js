// SIH Privacy Browser Agent — multi-step private agent
// Raw screenshots stay local; only sanitized context reaches FastAPI.

console.log(
    " SIH Privacy Agent popup loaded"
);

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

const API_URL =
    "https://devins.onrender.com/analyze";

const MAX_AGENT_STEPS = 4;

const ACTION_SETTLE_DELAY_MS = 500;

const MAX_CAPTURE_RETRIES = 5;

const CAPTURE_RETRY_DELAY_MS = 500;
const MAX_ACTION_RETRIES = 2;

const ACTION_RETRY_DELAY_MS = 400;

let agentRunning = false;

let completedActions = [];

let totalPlannerLatency = 0;

let totalNetworkLatency = 0;
let currentActionRetryCount = 0;

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

function getTask() {

    const task =
        taskInput?.value?.trim() ||
        "";

    return (
        task ||
        "Analyze the page and choose the safest useful action."
    );
}

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

function isScrollClickCompoundTask(
    task
) {

    const t =
        String(task || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

    return (
        /\bscroll\b/i.test(t) &&
        /\bclick\b/i.test(t)
    );
}

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

function buildAgentTaskSteps(
    task
) {

    const original =
        String(task || "").trim();

    const normalized =
        original
            .replace(/\s+/g, " ")
            .trim();

    if (isSubmitCompoundTask(original)) {

        const valueMatch =
            normalized.match(
                /["“]([^"”]+)["”]|['‘]([^'’]+)['’]/
            );

        const value =
            valueMatch
                ? (
                    valueMatch[1] ??
                    valueMatch[2] ??
                    ""
                ).trim()
                : "";

        let fieldTarget = "";

        const findFieldMatch =
            normalized.match(
                /\b(?:find|locate)\s+(?:the\s+)?(.+?)\s+field\b/i
            );

        if (findFieldMatch) {
            fieldTarget =
                findFieldMatch[1].trim();
        } else {
            const fillFieldMatch =
                normalized.match(
                    /\b(?:fill|enter|type|write|input|insert|put)\s+(?:the\s+)?(.+?)\s+field\b/i
                );

            if (fillFieldMatch) {
                fieldTarget =
                    fillFieldMatch[1].trim();
            }
        }

        if (fieldTarget && value) {
            return [
                `Click the ${fieldTarget} field`,
                `Type "${value}" into the ${fieldTarget} field`,
                "Click Submit"
            ];
        }
    }

    if (isScrollClickCompoundTask(original)) {

        const clickButtonMatch =
            normalized.match(
                /\bclick\s+(?:the\s+)?(.+?)\s+button\b/i
            );

        const clickTargetMatch =
            normalized.match(
                /\bclick\s+(?:the\s+)?(.+?)(?:[.!?]|$)/i
            );

        const target =
            (
                clickButtonMatch
                    ? clickButtonMatch[1]
                    : clickTargetMatch
                        ? clickTargetMatch[1]
                        : ""
            )
                .replace(/\bbutton\b$/i, "")
                .trim();

        if (target) {
            return [
                `Scroll down to find the ${target} button`,
                `Click the ${target} button`
            ];
        }
    }

    return [
        original
    ];
}

// ============================================================
// RUNTIME MESSAGE WITH TIMEOUT
// Prevents the agent button from spinning forever.
// ============================================================

function sendRuntimeMessage(
    message,
    timeoutMs = 60000
) {

    return new Promise(
        function (
            resolve,
            reject
        ) {

            let finished = false;


            const timeoutId =
                setTimeout(
                    function () {

                        if (finished) {
                            return;
                        }


                        finished = true;


                        reject(
                            new Error(
                                `Extension request timed out after ${timeoutMs / 1000}s.`
                            )
                        );

                    },
                    timeoutMs
                );


            try {

                chrome.runtime.sendMessage(
                    message,
                    function (response) {

                        if (finished) {
                            return;
                        }


                        finished = true;


                        clearTimeout(
                            timeoutId
                        );


                        const runtimeError =
                            chrome.runtime.lastError;


                        if (runtimeError) {

                            reject(
                                new Error(
                                    runtimeError.message ||
                                    "Extension runtime request failed."
                                )
                            );

                            return;
                        }


                        resolve(
                            response
                        );

                    }
                );

            } catch (error) {

                if (finished) {
                    return;
                }


                finished = true;


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

async function captureSanitizedScreen() {

    console.log(
        " Requesting local capture + sanitization..."
    );

    const response =
        await sendRuntimeMessage(
            {
                type:
                    "CAPTURE_AND_SANITIZE"
            },
            60000
        );

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
        await sendRuntimeMessage(
            {
                type:
                    "EXECUTE_BROWSER_ACTION",

                action:
                    action
            },
            30000
        );

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

async function waitForActionToSettle() {

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                ACTION_SETTLE_DELAY_MS
            )
    );
}

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

const rawPageUrl =
    String(
        captureResponse.page_url || ""
    );

let safePageUrl = "";

try {
    const parsedUrl =
        new URL(rawPageUrl);

    safePageUrl =
        parsedUrl.origin;

} catch (_) {
    safePageUrl = "";
}

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

    const safeTask =
        String(task || "").trim();

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

function isRetryableActionFailure(response) {

    if (
        !response ||
        typeof response !== "object"
    ) {
        return false;
    }

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

        const compoundTask =
            isSubmitCompoundTask(
                originalTask
            );

        console.log(
            " Compound task:",
            compoundTask
        );

        const agentTaskSteps =
            buildAgentTaskSteps(
                originalTask
            );

        let currentTaskIndex = 0;

        let currentTask =
            agentTaskSteps[currentTaskIndex];

        console.log(
            "[AGENT] Ordered task steps:",
            agentTaskSteps
        );

        let currentCapture =
            await captureSanitizedScreen();

        let finalCapture =
            currentCapture;

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

            showProgress(

                originalTask,

                step,

                analysis.actionType,

                analysis.confidence,

                analysis.reason,

                analysis.detections
            );

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

currentActionRetryCount = 0;

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
                    " Final CLICK SUBMIT step completed."
                );

                console.log(
                    " All requested browser actions executed successfully."
                );

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

            currentCapture =
                finalCapture;

            if (
                currentTaskIndex + 1 <
                agentTaskSteps.length
            ) {

                currentTaskIndex += 1;

                currentTask =
                    agentTaskSteps[currentTaskIndex];

                console.log(
                    "[AGENT] Next task step:",
                    {
                        index:
                            currentTaskIndex,
                        task:
                            currentTask,
                        afterAction:
                            analysis.actionType
                    }
                );

                continue;
            }

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

if (captureButton) {

    captureButton.addEventListener(
        "click",
        captureAndAnalyze
    );
}

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
    " Ordered CLICK → TYPE → SUBMIT flow enabled"
);

console.log(
    " Ordered SCROLL → CLICK flow enabled"
);