// =========================================================
// SIH PRIVACY BROWSER AGENT
// POPUP
// Day 2.2
// =========================================================


const button =
    document.getElementById(
        "sanitizeButton"
    );


const result =
    document.getElementById(
        "result"
    );


const preview =
    document.getElementById(
        "preview"
    );


// =========================================================
// MAIN BUTTON
// =========================================================

button.addEventListener(
    "click",
    async () => {


        button.disabled =
            true;


        button.textContent =
            "⏳ Processing locally...";


        result.textContent =
            "Capturing and sanitizing screen...";


        preview.style.display =
            "none";


        try {


            // =================================================
            // STEP 1 — LOCAL PRIVACY PIPELINE
            // =================================================

            const response =
                await chrome.runtime.sendMessage({

                    type:
                        "CAPTURE_AND_SANITIZE"

                });


            console.log(
                "🛡️ Local sanitization response:",
                response
            );


            if (
                !response ||
                !response.success
            ) {

                throw new Error(

                    response?.error ||
                    "Local sanitization failed"

                );

            }


            console.log(
                "🔢 Detection count:",
                response.detectionCount
            );


            console.log(
                "📦 Detections:",
                response.detections
            );


            // =================================================
            // STEP 2 — SHOW SANITIZED IMAGE
            // =================================================

            preview.src =
                response.sanitizedImage;


            preview.style.display =
                "block";


            result.innerHTML = `

                <strong>
                    ✅ Local sanitization complete
                </strong>

                <br><br>

                PII regions redacted:
                <b>
                    ${response.detectionCount}
                </b>

                <br><br>

                🔒 Raw screenshot never leaves browser.

                <br><br>

                Sending sanitized visual context...

            `;


            // =================================================
            // STEP 3 — SEND TO FASTAPI
            // =================================================

            const payload = {

                screenshot:
                    response.sanitizedImage,

                detections:
                    response.detections || [],

                page_url:
                    response.pageUrl || null,

                dom_elements:
                    response.domElements || []

            };


            console.log(
                "📤 Sending sanitized payload:",
                {
                    detections:
                        payload.detections.length,

                    pageUrl:
                        payload.page_url
                }
            );


            const serverResponse =
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
                            JSON.stringify(
                                payload
                            )

                    }

                );


            if (
                !serverResponse.ok
            ) {

                throw new Error(

                    `FastAPI returned HTTP ${serverResponse.status}`

                );

            }


            // =================================================
            // STEP 4 — RECEIVE AI ACTION
            // =================================================

            const aiResult =
                await serverResponse.json();


            console.log(
                "🤖 AI server response:",
                aiResult
            );


            if (
                !aiResult.success
            ) {

                throw new Error(

                    aiResult.action?.reason ||
                    "AI analysis failed"

                );

            }


            const action =
                aiResult.action;


            console.log(
                "🎯 Action received:",
                action
            );


            // =================================================
            // STEP 5 — EXECUTE ACTION
            // =================================================

            result.innerHTML = `

                <strong>
                    🤖 AI action generated
                </strong>

                <br><br>

                <b>Action:</b>
                ${action.type}

                <br>

                <b>Confidence:</b>
                ${action.confidence}

                <br>

                <b>Reason:</b>
                ${action.reason}

                <br><br>

                Executing browser action...

            `;


            let executionResult =
                null;


            if (
                action.type !==
                "none"
            ) {


                console.log(
                    "🚀 Sending action to extension:",
                    action
                );


                executionResult =
                    await chrome.runtime.sendMessage({

                        type:
                            "EXECUTE_BROWSER_ACTION",

                        action:
                            action

                    });


                console.log(
                    "🖱️ Execution response:",
                    executionResult
                );

            }


            // =================================================
            // STEP 6 — SHOW FINAL RESULT
            // =================================================

            if (
                action.type ===
                "none"
            ) {

                result.innerHTML = `

                    <strong>
                        ℹ️ No action required
                    </strong>

                    <br><br>

                    <b>Reason:</b>
                    ${action.reason}

                    <br><br>

                    <b>Server latency:</b>
                    ${aiResult.processing_time_ms} ms

                `;

            }


            else if (
                executionResult &&
                executionResult.success
            ) {

                result.innerHTML = `

                    <strong>
                        ✅ AI action executed
                    </strong>

                    <br><br>

                    <b>Action:</b>
                    ${action.type}

                    <br>

                    <b>Confidence:</b>
                    ${action.confidence}

                    <br>

                    <b>Reason:</b>
                    ${action.reason}

                    <br><br>

                    <b>Execution:</b>
                    ✅ Successful

                    <br>

                    <b>Server latency:</b>
                    ${aiResult.processing_time_ms} ms

                `;

            }


            else {

                const error =
                    executionResult?.error ||
                    "Unknown execution error";


                result.innerHTML = `

                    <strong>
                        ⚠️ AI action generated
                    </strong>

                    <br><br>

                    <b>Action:</b>
                    ${action.type}

                    <br>

                    <b>Confidence:</b>
                    ${action.confidence}

                    <br>

                    <b>Reason:</b>
                    ${action.reason}

                    <br><br>

                    <b>Execution:</b>
                    ❌ Failed

                    <br>

                    <b>Error:</b>
                    ${error}

                `;

            }


        }


        catch (error) {


            console.error(
                "❌ Pipeline error:",
                error
            );


            result.innerHTML = `

                <strong>
                    ❌ Pipeline error
                </strong>

                <br><br>

                <b>Error:</b>
                ${error.message}

            `;

        }


        button.disabled =
            false;


        button.textContent =
            "🛡️ Capture & Sanitize Screen";

    }
);