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
    "🟢 SIH Privacy Agent popup loaded"
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


if (!captureButton) {

    console.error(
        "❌ Capture button not found."
    );
}


if (!taskInput) {

    console.error(
        "❌ Task input not found."
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


// ============================================================
// AGENT STATE
// ============================================================

let agentRunning = false;

let completedActions = [];

let totalPlannerLatency = 0;

let totalNetworkLatency = 0;


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
                🛡️ Execute Private Agent
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
        "📸 Requesting local capture + sanitization..."
    );


    const response =
        await chrome.runtime.sendMessage({

            type:
                "CAPTURE_AND_SANITIZE"
        });


    console.log(
        "📨 Capture response:",
        response
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
        "🔒 Sanitized screenshot received."
    );


    console.log(
        "🛡️ Local PII detections:",
        response.detections?.length || 0
    );


    console.log(
        "🧩 Safe DOM elements:",
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
        "🎯 Sending action to browser:",
        action
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
        "🖱️ Execution response:",
        response
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
        "📸 Capturing final/new sanitized page state..."
    );


    let lastError = null;


    for (
        let attempt = 1;
        attempt <= MAX_CAPTURE_RETRIES;
        attempt++
    ) {

        try {

            console.log(
                `📸 Capture attempt ${attempt}/${MAX_CAPTURE_RETRIES}`
            );


            const finalCapture =
                await captureSanitizedScreen();


            console.log(
                "🛡️ New sanitized screenshot captured."
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
                `⚠️ Chrome capture quota hit on attempt ${attempt}.`
            );


            if (
                attempt <
                MAX_CAPTURE_RETRIES
            ) {

                console.log(
                    `⏳ Waiting ${CAPTURE_RETRY_DELAY_MS} ms before retry...`
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
        "🔒 Screenshot:",
        sanitizedImage
            ? "SANITIZED"
            : "MISSING"
    );


    console.log(
        "🛡️ PII detections:",
        detections.length
    );


    console.log(
        "🧩 Safe DOM elements:",
        domElements.length
    );


    console.log(
        "📝 Planner task:",
        task
    );


    console.log(
        "🌐 Page:",
        pageUrl
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
                    JSON.stringify({

                        screenshot:
                            sanitizedImage,

                        detections:
                            detections,

                        page_url:
                            pageUrl,

                        dom_elements:
                            domElements,

                        viewport:
                            viewport,

                        task:
                            task
                    })
            }
        );


    const networkLatency =
        performance.now() -
        startTime;


    totalNetworkLatency +=
        networkLatency;


    console.log(
        `🌐 Network latency: ${networkLatency.toFixed(2)} ms`
    );


    if (!response.ok) {

        throw new Error(
            `FastAPI returned HTTP ${response.status}`
        );
    }


    const data =
        await response.json();


    console.log(
        "🤖 Planner response:",
        data
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

                            <span class="success">
                                ✅
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

        "ℹ️ Agent completed",

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
                    Reason:
                </span>

                ${escapeHTML(reason)}
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
                🔒 Screenshot sanitized locally.
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

        "⚠️ Agent Action Failed",

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
                    Reason:
                </span>

                ${escapeHTML(reason)}
            </div>

            <div class="row error">
                Execution: ❌ Failed
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
                🔒 Raw screenshot was not sent to the AI.
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
                                ✅ Successful
                            </span>
                        </div>
                    `;
                }
            )
            .join("");


    showResult(

        "✅ Private Agent Completed",

        `
            <div class="privacy-badge">
                🔒 SANITIZED BEFORE EVERY AI STEP
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
                🔒 Sensitive pixels are redacted locally.
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

        `🤖 Agent Step ${stepNumber}`,

        `
            <div class="privacy-badge">
                🔒 SANITIZED BEFORE AI
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
                    Reason:
                </span>

                ${escapeHTML(reason)}
            </div>

            <div class="row">
                <span class="label">
                    PII detections:
                </span>

                ${detections.length}
            </div>

            ${renderActionHistory()}

            <div class="small">
                🔄 Executing step ${stepNumber}...
            </div>
        `,

        true
    );
}


// ============================================================
// MAIN MULTI-STEP AGENT PIPELINE
// ============================================================

async function captureAndAnalyze() {

    if (agentRunning) {

        console.log(
            "⚠️ Agent is already running."
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
            "📝 User task:",
            originalTask
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

                "🔒 Explicit value required",

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
            "🔀 Compound task:",
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
                "📝 Planner task:",
                currentTask
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
                "🤖 Action:",
                analysis.actionType
            );


            console.log(
                "🎯 Confidence:",
                analysis.confidence
            );


            console.log(
                "💡 Reason:",
                analysis.reason
            );


            // =================================================
            // NO ACTION
            // =================================================

            if (
                analysis.actionType ===
                "none"
            ) {

                console.log(
                    "ℹ️ Planner returned no safe action."
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
                `🚀 Executing step ${step}:`,
                describeAction(
                    analysis.action
                )
            );


            const executionResponse =
                await executeAction(
                    analysis.action
                );


            console.log(
                "⚙️ Execution response:",
                executionResponse
            );


            const executionSuccess =
                Boolean(
                    executionResponse?.success
                );


            // =================================================
            // EXECUTION FAILURE
            // =================================================

            if (!executionSuccess) {

                console.error(
                    "❌ Browser action failed:",
                    executionResponse
                );


                showExecutionFailure(

                    originalTask,

                    analysis,

                    currentCapture.sanitizedImage,

                    executionResponse
                );


                return;
            }


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

                reason:
                    analysis.reason,

                plannerLatency:
                    analysis.plannerLatency,

                networkLatency:
                    analysis.networkLatency
            });


            console.log(
                `✅ Step ${step} executed successfully.`
            );


            console.log(
                "📊 Completed actions:",
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
                    "🎉 COMPOUND TASK COMPLETED"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    "✅ TYPE step completed."
                );


                console.log(
                    "✅ CLICK SUBMIT step completed."
                );


                console.log(
                    "🎯 All requested browser actions executed successfully."
                );


                // ------------------------------------------------
                // TRY FINAL SANITIZED CAPTURE
                // ------------------------------------------------

                await waitForActionToSettle();


                try {

                    finalCapture =
                        await captureFinalState();


                    console.log(
                        "🔒 Final sanitized state captured."
                    );

                } catch (finalCaptureError) {

                    console.warn(
                        "⚠️ Final sanitized capture unavailable:"
                    );


                    console.warn(
                        finalCaptureError
                    );


                    console.log(
                        "🔒 Keeping previous valid sanitized state."
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
                "📸 Capturing NEW state after action..."
            );


            try {

                finalCapture =
                    await captureFinalState();

            } catch (captureError) {

                console.error(
                    "❌ Post-action capture failed:",
                    captureError
                );


                showResult(

                    "⚠️ Action executed, but recapture failed",

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
                            ✅ Executed
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
                    "🔄 COMPOUND TASK CONTINUATION"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    "✅ TYPE step completed."
                );


                console.log(
                    "➡️ Next required action: CLICK SUBMIT"
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
                    "📝 Next planner task:",
                    currentTask
                );


                console.log(
                    "🔒 Fresh sanitized state assigned."
                );


                console.log(
                    "➡️ Continuing to next planner step..."
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
                    "🔄 COMPOUND TASK SCROLL CONTINUATION"
                );

                console.log(
                    "=========================================="
                );


                console.log(
                    "✅ SCROLL step completed."
                );


                console.log(
                    "➡️ Re-planning after scroll..."
                );


                // finalCapture is the fresh sanitized state
                // captured after the scroll action.

                currentCapture =
                    finalCapture;


                console.log(
                    "🔒 Fresh sanitized state assigned after scroll."
                );


                console.log(
                    "📝 Next planner task:",
                    currentTask
                );


                console.log(
                    "➡️ Continuing to next planner step..."
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
                "✅ Single-step task completed."
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

            "⚠️ Agent stopped safely",

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
            "❌ Private Agent pipeline error:",
            error
        );


        showResult(

            "❌ Pipeline Error",

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
            "Completed actions:",
            completedActions
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
    "✅ Private Agent popup listeners attached"
);


console.log(
    "🔒 Multi-step private agent enabled"
);


console.log(
    "🔒 Screenshot-only PII masking enabled"
);


console.log(
    "🤖 Compound TYPE → SUBMIT flow enabled"
);


console.log(
    "📜 Compound SCROLL → CONTINUE flow enabled"
);