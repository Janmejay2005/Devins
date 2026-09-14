const button =
    document.getElementById("sanitizeButton");

const result =
    document.getElementById("result");

const preview =
    document.getElementById("preview");


button.addEventListener("click", async () => {

    button.disabled = true;

    button.textContent =
        "⏳ Processing locally...";

    result.textContent =
        "Capturing and sanitizing screen...";

    preview.style.display =
        "none";


    try {

        // =================================================
        // STEP 1 — LOCAL PRIVACY ENGINE
        // =================================================

        const response =
            await chrome.runtime.sendMessage({

                type: "CAPTURE_AND_SANITIZE"

            });


        console.log(
            "🛡️ Local sanitization response:",
            response
        );


        console.log(
            "🔢 Detection count:",
            response?.detectionCount
        );


        console.log(
            "📦 Detections:",
            response?.detections
        );


        if (
            !response ||
            !response.success
        ) {

            throw new Error(
                response?.error ||
                "Sanitization failed"
            );

        }


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
            <b>${response.detectionCount}</b>

            <br><br>

            🔒 Raw screenshot never leaves browser.

            <br><br>

            Sending sanitized visual context
            to AI server...

        `;


        // =================================================
        // STEP 3 — SEND SANITIZED CONTEXT
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
                detectionCount:
                    payload.detections.length,

                pageUrl:
                    payload.page_url,

                domElementCount:
                    payload.dom_elements.length
            }
        );


        const serverResponse =
            await fetch(
                "http://127.0.0.1:8000/analyze",
                {

                    method: "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(payload)

                }
            );


        if (!serverResponse.ok) {

            throw new Error(
                `Server returned HTTP ${serverResponse.status}`
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


        if (!aiResult.success) {

            throw new Error(
                aiResult.action?.reason ||
                "AI analysis failed"
            );

        }


        const action =
            aiResult.action;


        // =================================================
        // STEP 5 — DISPLAY ACTION
        // =================================================

        result.innerHTML = `

            <strong>
                ✅ AI analysis complete
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

            <b>Server latency:</b>
            ${aiResult.processing_time_ms} ms

        `;


    } catch (error) {

        console.error(
            "❌ Agent pipeline error:",
            error
        );


        result.innerHTML = `

            <strong>
                ❌ Pipeline error
            </strong>

            <br><br>

            ${error.message}

        `;

    }


    button.disabled = false;

    button.textContent =
        "🛡️ Capture & Sanitize Screen";

});