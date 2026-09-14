console.log(
    "🚀 SIH Privacy Agent background service started"
);


chrome.runtime.onInstalled.addListener(() => {

    console.log(
        "✅ SIH Privacy Agent installed"
    );

});


/* =========================================================
   CAPTURE + SANITIZE PIPELINE
   ========================================================= */

chrome.runtime.onMessage.addListener(
    async (message, sender, sendResponse) => {

        if (
            message.type !==
            "CAPTURE_AND_SANITIZE"
        ) {

            return;

        }


        try {

            /*
             * Find the active tab.
             */

            const tabs =
                await chrome.tabs.query({

                    active: true,

                    currentWindow: true

                });


            const tab = tabs[0];


            if (!tab || !tab.id) {

                throw new Error(
                    "No active tab found"
                );

            }


            /*
             * Ask content script for local
             * PII bounding boxes.
             *
             * The raw screenshot does NOT
             * exist yet.
             */

            const preparation =
                await chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: "PREPARE_CAPTURE"
                    }
                );


            if (
                !preparation ||
                !preparation.success
            ) {

                throw new Error(
                    "Could not prepare page"
                );

            }


            /*
             * Capture visible tab.
             *
             * This image remains inside
             * the extension pipeline.
             */

            const rawScreenshot =
                await chrome.tabs.captureVisibleTab(
                    tab.windowId,
                    {
                        format: "png"
                    }
                );


            console.log(
                "📸 Raw screenshot captured locally"
            );


            /*
             * Send raw screenshot + local
             * bounding boxes back to the
             * content script.
             *
             * IMPORTANT:
             * This is still browser-local.
             */

            const sanitized =
                await chrome.tabs.sendMessage(
                    tab.id,
                    {

                        type:
                            "SANITIZE_SCREENSHOT",

                        screenshot:
                            rawScreenshot,

                        detections:
                            preparation.detections

                    }
                );


            if (
                !sanitized ||
                !sanitized.success
            ) {

                throw new Error(
                    "Canvas sanitization failed"
                );

            }


            console.log(
                "🛡️ Screenshot sanitized locally"
            );


            /*
             * Return ONLY the sanitized image
             * to the popup.
             */

            sendResponse({

                success: true,

                detectionCount:
                    preparation.detections.length,

                sanitizedImage:
                    sanitized.sanitizedImage

            });


        } catch (error) {

            console.error(
                "❌ Privacy pipeline error:",
                error
            );


            sendResponse({

                success: false,

                error: error.message

            });

        }


        return true;

    }
);