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

        const response =
            await chrome.runtime.sendMessage({

                type: "CAPTURE_AND_SANITIZE"

            });


        if (!response || !response.success) {

            throw new Error(
                response?.error ||
                "Sanitization failed"
            );

        }


        result.innerHTML = `

            <strong>✅ Sanitization complete</strong>

            <br>

            PII regions redacted:
            ${response.detectionCount}

            <br>

            Raw screenshot was processed
            locally.

        `;


        preview.src =
            response.sanitizedImage;

        preview.style.display =
            "block";


    } catch (error) {

        console.error(error);

        result.innerHTML = `

            <strong>❌ Error</strong>

            <br>

            ${error.message}

        `;

    }


    button.disabled = false;

    button.textContent =
        "🛡️ Capture & Sanitize Screen";

});