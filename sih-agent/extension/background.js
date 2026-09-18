// ============================================================
// SIH PRIVACY BROWSER AGENT
// background.js
// ============================================================

console.log(
    "🔵 SIH Privacy Agent background service started"
);


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
    // LOCAL SANITIZATION
    //
    // IMPORTANT:
    //
    // The raw screenshot is used ONLY inside the extension
    // for local sanitization.
    //
    // The raw screenshot is NEVER sent to FastAPI.
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

        success:
            true,

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
// NORMALIZE AI ACTION
// ============================================================
//
// The FAST planner returns:
//
// {
//     "action": "click",
//     "x": 604,
//     "y": 310,
//     "text": "",
//     "amount": 0,
//     "confidence": 0.98,
//     "reason": "Matched Full Name..."
// }
//
// The content.js executor expects:
//
// {
//     "type": "click",
//     "target": {
//         "x": 604,
//         "y": 310
//     }
// }
//
// This function converts the new format into the format
// expected by content.js.
//
// ============================================================

function normalizeBrowserAction(
    action
) {

    // ========================================================
    // INVALID ACTION
    // ========================================================

    if (
        !action ||
        typeof action !== "object"
    ) {

        console.warn(
            "⚠️ Invalid AI action received:",
            action
        );


        return {

            type:
                "none",

            error:
                "No valid AI action was received."
        };
    }


    // ========================================================
    // ALREADY NORMALIZED
    // ========================================================
    //
    // If content.js format is already being used, don't
    // modify it.
    //
    // Example:
    //
    // {
    //     type: "click",
    //     target: {
    //         x: 604,
    //         y: 310
    //     }
    // }
    //
    // ========================================================

    if (
        action.type
    ) {

        console.log(
            "ℹ️ Action already uses content-script format."
        );


        return action;
    }


    // ========================================================
    // READ NEW ACTION FORMAT
    // ========================================================

    const actionName =
        String(
            action.action || ""
        )
        .toLowerCase()
        .trim();


    console.log(
        "🔍 AI action name:",
        actionName
    );


    // ========================================================
    // CLICK
    // ========================================================

    if (
        actionName ===
        "click"
    ) {

        const x =
            Number(
                action.x
            );


        const y =
            Number(
                action.y
            );


        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        ) {

            return {

                type:
                    "none",

                error:
                    "AI returned invalid click coordinates."
            };
        }


        return {

            type:
                "click",

            target: {

                x:
                    x,

                y:
                    y
            },

            confidence:
                action.confidence ??
                0,

            reason:
                action.reason ||
                ""
        };
    }


    // ========================================================
    // TYPE
    // ========================================================

    if (
        actionName ===
        "type"
    ) {

        const x =
            Number(
                action.x
            );


        const y =
            Number(
                action.y
            );


        const value =
            action.text ??
            action.value ??
            "";


        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y)
        ) {

            return {

                type:
                    "none",

                error:
                    "AI returned invalid type coordinates."
            };
        }


        return {

            type:
                "type",

            target: {

                x:
                    x,

                y:
                    y
            },

            value:
                String(
                    value
                ),

            confidence:
                action.confidence ??
                0,

            reason:
                action.reason ||
                ""
        };
    }


    // ========================================================
    // SCROLL
    // ========================================================

    if (
        actionName ===
        "scroll"
    ) {

        let amount =
            Number(
                action.amount ??
                action.value ??
                500
            );


        if (
            !Number.isFinite(
                amount
            )
        ) {

            amount =
                500;
        }


        return {

            type:
                "scroll",

            value:
                amount,

            confidence:
                action.confidence ??
                0,

            reason:
                action.reason ||
                ""
        };
    }


    // ========================================================
    // WAIT
    // ========================================================

    if (
        actionName ===
        "wait"
    ) {

        let milliseconds =
            Number(
                action.amount ??
                action.value ??
                1000
            );


        if (
            !Number.isFinite(
                milliseconds
            )
        ) {

            milliseconds =
                1000;
        }


        return {

            type:
                "wait",

            value:
                milliseconds,

            confidence:
                action.confidence ??
                0,

            reason:
                action.reason ||
                ""
        };
    }


    // ========================================================
    // NONE
    // ========================================================

    if (
        actionName ===
        "none"
    ) {

        return {

            type:
                "none",

            confidence:
                action.confidence ??
                0,

            reason:
                action.reason ||
                ""
        };
    }


    // ========================================================
    // UNKNOWN ACTION
    // ========================================================

    console.error(
        "❌ Unsupported AI action:",
        action
    );


    return {

        type:
            "none",

        error:
            `Unsupported AI action: ${
                actionName ||
                "missing"
            }`
    };
}


// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================

async function executeBrowserAction(
    action
) {

    console.log(
        "🤖 AI action received:",
        action
    );


    // ========================================================
    // NORMALIZE ACTION
    // ========================================================

    const normalizedAction =
        normalizeBrowserAction(
            action
        );


    console.log(
        "🔄 Normalized browser action:",
        normalizedAction
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


    // ========================================================
    // UNKNOWN ACTION SAFETY CHECK
    // ========================================================

    if (
        normalizedAction.type ===
            "none" &&
        normalizedAction.error
    ) {

        return {

            success:
                false,

            error:
                normalizedAction.error
        };
    }


    // ========================================================
    // SEND ACTION TO CONTENT SCRIPT
    // ========================================================

    let response;


    try {

        console.log(
            "📤 Sending normalized action to content script..."
        );


        response =
            await chrome.tabs.sendMessage(
                tab.id,
                {
                    type:
                        "EXECUTE_ACTION",

                    action:
                        normalizedAction
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


    // ========================================================
    // LOG CONTENT SCRIPT RESULT
    // ========================================================

    console.log(
        "✅ Content script action result:",
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

                            success:
                                false,

                            error:
                                error.message
                        });
                    }
                );


            // Keep the message channel open for
            // the asynchronous response.

            return true;
        }


        // ====================================================
        // EXECUTE ACTION
        // ====================================================

        if (
            message?.type ===
            "EXECUTE_BROWSER_ACTION"
        ) {

            console.log(
                "🎯 EXECUTE_BROWSER_ACTION received:",
                message.action
            );


            executeBrowserAction(
                message.action
            )

                .then(
                    result => {

                        console.log(
                            "🎉 Browser action completed:",
                            result
                        );


                        sendResponse({

                            success:
                                result?.success !== false,

                            result:
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

                            success:
                                false,

                            error:
                                error.message
                        });
                    }
                );


            // Keep the message channel open.

            return true;
        }


        // ====================================================
        // UNKNOWN MESSAGE
        // ====================================================

        console.warn(
            "⚠️ Unknown background message:",
            message?.type
        );


        return false;
    }
);