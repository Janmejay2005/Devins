// ============================================================
// SIH PRIVACY BROWSER AGENT
// popup.js
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

const taskInput =
    document.getElementById(
        "taskInput"
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


// ============================================================
// SAFETY CHECK
// ============================================================

if (!captureButton) {

    console.error(
        "❌ Execute button not found."
    );
}


if (!taskInput) {

    console.error(
        "❌ Task input not found."
    );
}


// ============================================================
// SHOW RESULT
// ============================================================

function showResult(
    title,
    content,
    success = true
) {

    result.classList.remove(
        "hidden"
    );

    resultTitle.textContent =
        title;

    resultContent.innerHTML =
        content;

    resultTitle.className =
        success
            ? "result-title success"
            : "result-title error";
}


// ============================================================
// SET BUTTON LOADING
// ============================================================

function setLoading(
    loading
) {

    if (loading) {

        captureButton.disabled =
            true;

        captureButton.innerHTML =
            `<span class="loading"></span>
             Running Private Agent...`;

    } else {

        captureButton.disabled =
            false;

        captureButton.innerHTML =
            `🛡️ Execute Private Agent`;
    }
}


// ============================================================
// QUICK TASK BUTTONS
// ============================================================

const quickTaskButtons =
    document.querySelectorAll(
        ".quick-task"
    );


quickTaskButtons.forEach(
    button => {

        button.addEventListener(
            "click",
            () => {

                const task =
                    button.dataset.task ||
                    "";

                taskInput.value =
                    task;

                taskInput.focus();

                console.log(
                    "📝 Quick task selected:",
                    task
                );
            }
        );

    }
);


// ============================================================
// MAIN AGENT PIPELINE
// ============================================================

async function captureAndAnalyze() {

    console.log(
        "🚀 Private Agent started"
    );


    // --------------------------------------------------------
    // TASK
    // --------------------------------------------------------

    const task =
        taskInput.value.trim();


    if (!task) {

        showResult(

            "⚠️ Task required",

            `
                <div class="row error">

                    Please enter a task for
                    the browser agent.

                </div>

                <div class="small">

                    Example:
                    <b>Click the Full Name field</b>

                </div>
            `,

            false
        );

        taskInput.focus();

        return;
    }


    console.log(
        "📝 User task:",
        task
    );


    setLoading(true);


    result.classList.add(
        "hidden"
    );


    try {

        // ====================================================
        // STEP 1 — CAPTURE + LOCAL SANITIZATION
        // ====================================================

        console.log(
            "📸 Requesting local capture..."
        );


        const captureResponse =
            await chrome.runtime.sendMessage({

                type:
                    "CAPTURE_AND_SANITIZE"

            });


        console.log(
            "📨 Capture response:",
            captureResponse
        );


        if (!captureResponse) {

            throw new Error(
                "No response received from background service."
            );
        }


        if (!captureResponse.success) {

            throw new Error(
                captureResponse.error ||
                "Capture and sanitization failed."
            );
        }


        const sanitizedImage =
            captureResponse.sanitizedImage;


        if (!sanitizedImage) {

            throw new Error(
                "Sanitized screenshot was not returned."
            );
        }


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


        console.log(
            "🛡️ Local PII detections:",
            detections.length
        );


        console.log(
            "🧩 Safe DOM elements:",
            domElements.length
        );


        console.log(
            "🌐 Page:",
            pageUrl
        );


        // ====================================================
        // STEP 1 RESULT
        // ====================================================

        showResult(

            "🛡️ Screen sanitized locally",

            `

                <div class="privacy-badge">

                    🔒 PRIVACY PROTECTED

                </div>


                <div class="row">

                    <span class="label">
                        Task:
                    </span>

                    ${escapeHTML(task)}

                </div>


                <div class="row">

                    <span class="label">
                        Privacy detections:
                    </span>

                    ${detections.length}

                </div>


                <div class="row">

                    <span class="label">
                        Safe DOM elements:
                    </span>

                    ${domElements.length}

                </div>


                <div class="row">

                    <span class="label">
                        Network payload:
                    </span>

                    Sanitized screenshot only

                </div>


                <img
                    class="preview"
                    src="${sanitizedImage}"
                    alt="Sanitized screenshot"
                />


                <div class="small">

                    Raw sensitive pixels were redacted
                    locally before AI processing.

                </div>

            `,

            true
        );


        // ====================================================
        // STEP 2 — SEND SANITIZED DATA TO FASTAPI
        // ====================================================

        console.log(
            "🌐 Sending sanitized context to FastAPI..."
        );


        const startTime =
            performance.now();


        const response =
            await fetch(
                "http://127.0.0.1:8000/analyze",
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            // IMPORTANT:
                            // Only sanitized screenshot
                            // is sent to backend.

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

                            // NEW:
                            // Send user's actual task.

                            task:
                                task

                        })

                }
            );


        const serverLatency =
            performance.now() -
            startTime;


        console.log(
            "⏱️ Server request latency:",
            serverLatency.toFixed(2),
            "ms"
        );


        if (!response.ok) {

            throw new Error(
                `FastAPI returned HTTP ${response.status}`
            );
        }


        const data =
            await response.json();


        console.log(
            "🤖 AI response:",
            data
        );


        if (!data.success) {

            throw new Error(
                data.error ||
                "AI analysis failed."
            );
        }


        // ====================================================
        // STEP 3 — READ ACTION
        // ====================================================

        const action =
            data.action ||
            {
                action: "none"
            };


        // IMPORTANT:
        // Backend returns "action".
        // Older popup expected "type".
        // We now support both.

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


        console.log(
            "🎯 Action received:",
            action
        );


        // ====================================================
        // NONE ACTION
        // ====================================================

        if (
            actionType ===
            "none"
        ) {

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

                        none

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
                            data.vlm_latency_ms ||
                            data.processing_time_ms ||
                            0
                        ).toFixed(2)} ms

                    </div>


                    <img
                        class="preview"
                        src="${sanitizedImage}"
                        alt="Sanitized screenshot"
                    />

                `,

                true
            );


            return;
        }


        // ====================================================
        // STEP 4 — EXECUTE ACTION IN BROWSER
        // ====================================================

        console.log(
            "🖱️ Executing browser action:",
            actionType
        );


        const executionResponse =
            await chrome.runtime.sendMessage({

                type:
                    "EXECUTE_BROWSER_ACTION",

                action:
                    action

            });


        console.log(
            "🖱️ Execution response:",
            executionResponse
        );


        const executionSuccess =
            executionResponse &&
            executionResponse.success;


        let executionHTML;


        if (
            executionSuccess
        ) {

            executionHTML = `

                <div class="row success">

                    <span class="label">
                        Execution:
                    </span>

                    ✅ Successful

                </div>

            `;

        } else {

            executionHTML = `

                <div class="row error">

                    <span class="label">
                        Execution:
                    </span>

                    ❌ Failed

                </div>


                <div class="row error">

                    ${escapeHTML(
                        executionResponse?.error ||
                        executionResponse?.result?.error ||
                        "Unknown execution error"
                    )}

                </div>

            `;
        }


        // ====================================================
        // STEP 5 — FINAL RESULT
        // ====================================================

        showResult(

            executionSuccess
                ? "✅ Private Agent Action Executed"
                : "⚠️ Agent Action Failed",

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
                        Action:
                    </span>

                    ${escapeHTML(
                        actionType
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

                    ${escapeHTML(
                        reason
                    )}

                </div>


                ${executionHTML}


                <div class="row">

                    <span class="label">
                        Planner latency:
                    </span>

                    ${Number(
                        data.vlm_latency_ms ||
                        data.processing_time_ms ||
                        0
                    ).toFixed(2)} ms

                </div>


                <div class="row">

                    <span class="label">
                        PII detections:
                    </span>

                    ${detections.length}

                </div>


                <img
                    class="preview"
                    src="${sanitizedImage}"
                    alt="Sanitized screenshot"
                />


                <div class="small">

                    The screenshot shown above is the
                    sanitized version. Sensitive pixels
                    were removed locally before transmission.

                </div>

            `,

            executionSuccess
        );


    } catch (error) {

        console.error(
            "❌ Private Agent pipeline error:",
            error
        );


        showResult(

            "❌ Agent Pipeline Error",

            `

                <div class="error">

                    ${escapeHTML(
                        error.message ||
                        String(error)
                    )}

                </div>


                <div class="small">

                    Check the extension service worker
                    console and FastAPI terminal for
                    detailed logs.

                </div>

            `,

            false
        );


    } finally {

        setLoading(false);

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
// BUTTON EVENT
// ============================================================

captureButton.addEventListener(
    "click",
    captureAndAnalyze
);


// ============================================================
// ENTER KEY
// ============================================================

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


// ============================================================
// DEFAULT TASK
// ============================================================

taskInput.value =
    "Click the Full Name field";


console.log(
    "✅ Private Agent popup initialized"
);