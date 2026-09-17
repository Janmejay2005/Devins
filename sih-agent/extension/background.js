// ============================================================
// SIH PRIVACY BROWSER AGENT
// background.js
// ============================================================

console.log("🔵 SIH Privacy Agent background service started");


// ============================================================
// CAPTURE + SANITIZE
// ============================================================

async function captureAndSanitize() {

    console.log(
        "📸 Starting capture and sanitization..."
    );


    // ========================================================
    // GET ACTIVE TAB
    // ========================================================

    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });


    if (
        !tabs ||
        tabs.length === 0
    ) {

        throw new Error(
            "No active browser tab found."
        );
    }


    const tab =
        tabs[0];


    if (!tab.id) {

        throw new Error(
            "Active tab has no valid ID."
        );
    }


    console.log(
        "🌐 Active tab:",
        tab.id,
        tab.url
    );


    // ========================================================
    // PREPARE PRIVACY ENGINE
    // ========================================================

    let prepareResponse;


    try {

        prepareResponse =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "PREPARE_CAPTURE"
                }
            );

    } catch (error) {

        console.error(
            "❌ PREPARE_CAPTURE failed:",
            error
        );


        throw new Error(
            "Could not communicate with content script. " +
            "Please refresh the webpage and try again."
        );
    }


    if (
        !prepareResponse ||
        !prepareResponse.success
    ) {

        throw new Error(
            "Privacy engine could not prepare the capture."
        );
    }


    console.log(
        "🛡️ Capture prepared:",
        prepareResponse.detections?.length || 0,
        "PII detections"
    );


    // ========================================================
    // CAPTURE VISIBLE TAB
    // ========================================================

    let screenshot;


    try {

        screenshot =
            await chrome.tabs.captureVisibleTab(
                tab.windowId,
                {
                    format: "png"
                }
            );

    } catch (error) {

        console.error(
            "❌ Screenshot capture failed:",
            error
        );


        throw new Error(
            "Could not capture the current screen: " +
            error.message
        );
    }


    if (!screenshot) {

        throw new Error(
            "Browser returned an empty screenshot."
        );
    }


    console.log(
        "📸 Raw screenshot captured locally."
    );


    // ========================================================
    // SEND RAW SCREENSHOT TO CONTENT SCRIPT
    //
    // IMPORTANT:
    //
    // This screenshot is NEVER sent to FastAPI.
    //
    // The content script performs local pixel redaction.
    // ========================================================

    let sanitizeResponse;


    try {

        sanitizeResponse =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "SANITIZE_SCREENSHOT",

                    screenshot,

                    detections:
                        prepareResponse.detections || []
                }
            );

    } catch (error) {

        console.error(
            "❌ SANITIZE_SCREENSHOT failed:",
            error
        );


        throw new Error(
            "Could not sanitize the screenshot: " +
            error.message
        );
    }


    if (
        !sanitizeResponse ||
        !sanitizeResponse.success
    ) {

        throw new Error(
            sanitizeResponse?.error ||
            "Screenshot sanitization failed."
        );
    }


    if (
        !sanitizeResponse.sanitizedImage
    ) {

        throw new Error(
            "Sanitized screenshot was empty."
        );
    }


    console.log(
        "🛡️ Screenshot sanitized locally."
    );


    // ========================================================
    // RETURN ONLY SANITIZED DATA
    // ========================================================

    return {

        success: true,

        sanitizedImage:
            sanitizeResponse.sanitizedImage,

        detections:
            prepareResponse.detections || [],

        dom_elements:
            sanitizeResponse.dom_elements ||
            prepareResponse.dom_elements ||
            [],

        viewport:
            sanitizeResponse.viewport ||
            prepareResponse.viewport ||
            null,

        page_url:
            tab.url || "",

        tab_id:
            tab.id,

        window_id:
            tab.windowId
    };
}


// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================

async function executeBrowserAction(
    action
) {

    console.log(
        "🤖 Executing browser action:",
        action
    );


    const tabs =
        await chrome.tabs.query({
            active: true,
            currentWindow: true
        });


    if (
        !tabs ||
        tabs.length === 0
    ) {

        throw new Error(
            "No active tab found."
        );
    }


    const tab =
        tabs[0];


    if (!tab.id) {

        throw new Error(
            "Active tab has no valid ID."
        );
    }


    let response;


    try {

        response =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "EXECUTE_ACTION",

                    action
                }
            );

    } catch (error) {

        console.error(
            "❌ Action execution failed:",
            error
        );


        throw new Error(
            "Could not communicate with content script: " +
            error.message
        );
    }


    console.log(
        "✅ Browser action result:",
        response
    );


    return response;
}


// ============================================================
// MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {

        console.log(
            "📨 Background message:",
            message?.type
        );


        // ====================================================
        // CAPTURE + SANITIZE
        // ====================================================

        if (
            message?.type ===
            "CAPTURE_AND_SANITIZE"
        ) {

            captureAndSanitize()

                .then(
                    result => {

                        console.log(
                            "✅ Capture + sanitize complete"
                        );


                        sendResponse(
                            result
                        );
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "❌ Capture pipeline error:",
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


        // ====================================================
        // EXECUTE ACTION
        // ====================================================

        if (
            message?.type ===
            "EXECUTE_BROWSER_ACTION"
        ) {

            executeBrowserAction(
                message.action
            )

                .then(
                    result => {

                        sendResponse({

                            success:
                                result?.success !== false,

                            result
                        });
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "❌ Browser action error:",
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


        return false;
    }
);