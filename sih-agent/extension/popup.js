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
        "❌ Capture button not found."
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
             Capturing & Sanitizing...`;

    } else {

        captureButton.disabled =
            false;

        captureButton.innerHTML =
            `🛡️ Capture &amp; Sanitize Screen`;
    }
}


// ============================================================
// CAPTURE PIPELINE
// ============================================================

async function captureAndAnalyze() {

    console.log(
        "🚀 Capture button clicked"
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
            "📸 Requesting capture from background..."
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


        if (
            !captureResponse
        ) {

            throw new Error(
                "No response received from background service."
            );
        }


        if (
            !captureResponse.success
        ) {

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
        // SHOW SANITIZED IMAGE
        // ====================================================

        showResult(

            "🛡️ Screen sanitized locally",

            `
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
                    Raw sensitive pixels were redacted locally
                    before server processing.
                </div>
            `,

            true
        );


        // ====================================================
        // STEP 2 — SEND SANITIZED DATA TO FASTAPI
        // ====================================================

        console.log(
            "🌐 Sending sanitized data to FastAPI..."
        );


        const startTime =
            performance.now();


        const response =
            await fetch(
                "http://127.0.0.1:8000/analyze",
                {

                    method: "POST",

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
                                viewport
                        })
                }
            );


        const serverLatency =
            performance.now() -
            startTime;


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


        if (
            !data.success
        ) {

            throw new Error(
                data.error ||
                "AI analysis failed."
            );
        }


        // ====================================================
        // STEP 3 — DISPLAY ACTION
        // ====================================================

        const action =
            data.action ||
            {
                type: "none"
            };


        const actionType =
            action.type ||
            "none";


        const confidence =
            action.confidence ??
            0;


        const reason =
            action.reason ||
            "No reason provided";


        // ====================================================
        // NONE
        // ====================================================

        if (
            actionType ===
            "none"
        ) {

            showResult(

                "✅ AI analysis completed",

                `
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
                            Server latency:
                        </span>
                        ${Number(
                            data.processing_time_ms || 0
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
        // EXECUTE ACTION
        // ====================================================

        console.log(
            "🎯 Action received:",
            action
        );


        const executionResponse =
            await chrome.runtime.sendMessage({

                type:
                    "EXECUTE_BROWSER_ACTION",

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

                    Execution:
                    ✅ Successful

                </div>

            `;

        } else {

            executionHTML = `

                <div class="row error">

                    Execution:
                    ❌ Failed

                </div>

                <div class="row error">

                    ${
                        escapeHTML(
                            executionResponse?.error ||
                            executionResponse?.result?.error ||
                            "Unknown execution error"
                        )
                    }

                </div>

            `;
        }


        // ====================================================
        // FINAL UI
        // ====================================================

        showResult(

            "✅ AI action executed",

            `

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
                        Server latency:
                    </span>

                    ${Number(
                        data.processing_time_ms || 0
                    ).toFixed(2)} ms

                </div>


                <img
                    class="preview"
                    src="${sanitizedImage}"
                    alt="Sanitized screenshot"
                />

            `,

            executionSuccess
        );


    } catch (error) {

        console.error(
            "❌ Pipeline error:",
            error
        );


        showResult(

            "❌ Pipeline error",

            `
                <div class="error">

                    ${escapeHTML(
                        error.message ||
                        String(error)
                    )}

                </div>

                <div class="small">

                    Open the extension's service worker
                    console for detailed logs.

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

    return String(value ?? "")
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


console.log(
    "✅ Capture button listener attached"
);