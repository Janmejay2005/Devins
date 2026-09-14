// =========================================================
// SIH PRIVACY BROWSER AGENT
// BACKGROUND SERVICE WORKER
// Day 2.2
// =========================================================

console.log(
    "🚀 SIH Privacy Agent background service started"
);


// =========================================================
// INSTALL
// =========================================================

chrome.runtime.onInstalled.addListener(
    () => {

        console.log(
            "✅ SIH Privacy Agent installed"
        );

    }
);


// =========================================================
// MAIN MESSAGE ROUTER
// =========================================================

chrome.runtime.onMessage.addListener(

    (
        message,
        sender,
        sendResponse
    ) => {


        // =================================================
        // CAPTURE + SANITIZE
        // =================================================

        if (
            message.type ===
            "CAPTURE_AND_SANITIZE"
        ) {

            handleCaptureAndSanitize()
                .then(
                    sendResponse
                )
                .catch(
                    (error) => {

                        console.error(
                            "❌ Privacy pipeline error:",
                            error
                        );


                        sendResponse({

                            success: false,

                            error:
                                error.message

                        });

                    }
                );


            return true;

        }


        // =================================================
        // EXECUTE BROWSER ACTION
        // =================================================

        if (
            message.type ===
            "EXECUTE_BROWSER_ACTION"
        ) {

            executeAction(
                message.action
            )
                .then(
                    sendResponse
                )
                .catch(
                    (error) => {

                        console.error(
                            "❌ Action execution error:",
                            error
                        );


                        sendResponse({

                            success: false,

                            error:
                                error.message

                        });

                    }
                );


            return true;

        }

    }

);


// =========================================================
// CAPTURE + SANITIZE
// =========================================================

async function handleCaptureAndSanitize() {

    const tabs =
        await chrome.tabs.query({

            active: true,

            currentWindow: true

        });


    const tab =
        tabs[0];


    if (
        !tab ||
        !tab.id
    ) {

        throw new Error(
            "No active tab found"
        );

    }


    // -----------------------------------------------------
    // Ask content script for PII regions
    // -----------------------------------------------------

    const preparation =
        await chrome.tabs.sendMessage(

            tab.id,

            {

                type:
                    "PREPARE_CAPTURE"

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


    // -----------------------------------------------------
    // Capture visible tab
    // -----------------------------------------------------

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


    // -----------------------------------------------------
    // Sanitize inside browser
    // -----------------------------------------------------

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
            sanitized?.error ||
            "Canvas sanitization failed"
        );

    }


    console.log(
        "🛡️ Screenshot sanitized locally"
    );


    return {

        success: true,

        detectionCount:
            preparation.detections.length,

        sanitizedImage:
            sanitized.sanitizedImage,

        detections:
            preparation.detections,

        pageUrl:
            tab.url || null,

        domElements: []

    };

}


// =========================================================
// EXECUTE ACTION
// =========================================================

async function executeAction(
    action
) {

    const tabs =
        await chrome.tabs.query({

            active: true,

            currentWindow: true

        });


    const tab =
        tabs[0];


    if (
        !tab ||
        !tab.id
    ) {

        throw new Error(
            "No active tab found"
        );

    }


    console.log(
        "📨 Sending action to active tab:",
        action
    );


    const result =
        await chrome.tabs.sendMessage(

            tab.id,

            {

                type:
                    "EXECUTE_ACTION",

                action

            }

        );


    console.log(
        "✅ Content script returned:",
        result
    );


    return result;

}