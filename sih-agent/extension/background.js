// ============================================================
// SIH PRIVACY BROWSER AGENT
// background.js
// ============================================================

console.log(
    "[SIH] Privacy Agent background service started"
);


// ============================================================
// SANITIZE DETECTION METADATA
// ============================================================
//
// Defense-in-depth.
//
// The content script should already avoid serializing PII values.
// The background service applies a second privacy boundary before
// any metadata can reach the network layer.
//
// IMPORTANT:
// `value` is intentionally NOT included.
// ============================================================

function sanitizeDetectionMetadata(detections) {

    if (!Array.isArray(detections)) {
        return [];
    }

    return detections
        .map((detection) => {

            if (
                !detection ||
                typeof detection !== "object"
            ) {
                return null;
            }

            return {
                id: String(
                    detection.id || ""
                ),

                type: String(
                    detection.type || ""
                ),

                source: String(
                    detection.source || ""
                ),

                tagName: String(
                    detection.tagName || ""
                ),

                rect: detection.rect
                    ? {
                        left: Number(
                            detection.rect.left
                        ),

                        top: Number(
                            detection.rect.top
                        ),

                        right: Number(
                            detection.rect.right
                        ),

                        bottom: Number(
                            detection.rect.bottom
                        ),

                        width: Number(
                            detection.rect.width
                        ),

                        height: Number(
                            detection.rect.height
                        )
                    }
                    : null
            };
        })
        .filter(Boolean);
}


// ============================================================
// PRIVACY-SAFE ACTION LOGGING
// ============================================================
//
// NEVER log the complete action object.
//
// A type action can contain:
// {
//     text: "Amit Kumar"
// }
//
// or worse:
// {
//     text: "password123"
// }
//
// Therefore only non-sensitive metadata is logged.
//
// The REAL action object is still passed to the content script.
// Only the console representation is sanitized.
// ============================================================

function getSafeActionLog(action) {

    if (
        !action ||
        typeof action !== "object"
    ) {
        return {
            action: "none"
        };
    }

    const actionType =
        String(
            action.action ||
            action.type ||
            "none"
        )
            .toLowerCase()
            .trim();

    const safe = {
        action: actionType,

        confidence: Number(
            action.confidence || 0
        )
    };


    // --------------------------------------------------------
    // CLICK
    // --------------------------------------------------------

    if (
        actionType === "click"
    ) {

        safe.target = {
            x: Number(
                action.x ??
                action.target?.x ??
                0
            ),

            y: Number(
                action.y ??
                action.target?.y ??
                0
            )
        };
    }


    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------
    //
    // NEVER log:
    // action.text
    // action.value
    //
    // Only log its length.
    // --------------------------------------------------------

    if (
        actionType === "type"
    ) {

        safe.valueLength =
            String(
                action.text ??
                action.value ??
                ""
            ).length;
    }


    // --------------------------------------------------------
    // SCROLL / WAIT
    // --------------------------------------------------------

    if (
        actionType === "scroll" ||
        actionType === "wait"
    ) {

        safe.amount =
            Number(
                action.amount ??
                action.value ??
                0
            );
    }


    return safe;
}


// ============================================================
// PRIVACY-SAFE PAGE URL
// ============================================================
//
// Never transmit:
// - query parameters
// - URL fragments
// - username/password from URL
//
// Example:
//
// https://example.com/form?email=user@example.com&token=123
//
// becomes:
//
// https://example.com/form
// ============================================================

function getPrivacySafePageUrl(rawUrl) {

    if (!rawUrl) {
        return "";
    }

    try {

        const url =
            new URL(rawUrl);

        return (
            `${url.origin}${url.pathname}`
        );

    } catch (_) {

        return "";
    }
}


// ============================================================
// CAPTURE + SANITIZE
// ============================================================

async function captureAndSanitize() {

    console.log(
        "[CAPTURE] Starting local capture and sanitization..."
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
        "[CAPTURE] Active tab:",
        tab.id
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
            "[CAPTURE] PREPARE_CAPTURE failed:",
            error?.message || error
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
        "[PRIVACY] Local PII detection completed:",
        prepareResponse.detections?.length || 0,
        "regions"
    );


    // ========================================================
    // SANITIZE DETECTION METADATA
    // ========================================================
    //
    // IMPORTANT:
    // This happens AFTER prepareResponse exists.
    //
    // The previous version attempted to use
    // prepareResponse before it was declared.
    // ========================================================

    const safeDetections =
        sanitizeDetectionMetadata(
            prepareResponse.detections || []
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
            "[CAPTURE] Screenshot capture failed:",
            error?.message || error
        );

        throw new Error(
            "Could not capture the current screen: " +
            (error?.message || "Unknown capture error")
        );
    }


    if (!screenshot) {

        throw new Error(
            "Browser returned an empty screenshot."
        );
    }


    console.log(
        "[CAPTURE] Raw screenshot captured locally."
    );


    // ========================================================
    // LOCAL SANITIZATION
    // ========================================================
    //
    // IMPORTANT:
    //
    // The raw screenshot exists only inside the extension.
    //
    // It is sent to the content script solely so that local
    // redaction can be performed.
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

                    screenshot:

                        screenshot,

                    detections:
                        prepareResponse.detections || []
                }
            );

    } catch (error) {

        console.error(
            "[PRIVACY] SANITIZE_SCREENSHOT failed:",
            error?.message || error
        );

        throw new Error(
            "Could not sanitize the screenshot: " +
            (error?.message || "Unknown sanitization error")
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
        "[PRIVACY] Screenshot sanitized locally."
    );


    // ========================================================
    // SANITIZED DOM METADATA
    // ========================================================
    //
    // Only metadata is allowed to leave the extension.
    //
    // We intentionally do NOT log the DOM elements.
    // ========================================================

    const safeDomElements =
        Array.isArray(
            sanitizeResponse.dom_elements
        )
            ? sanitizeResponse.dom_elements
            : (
                Array.isArray(
                    prepareResponse.dom_elements
                )
                    ? prepareResponse.dom_elements
                    : []
            );


    // ========================================================
    // RETURN ONLY SANITIZED DATA
    // ========================================================

    return {

        success: true,

        // Sanitized screenshot only.
        sanitizedImage:
            sanitizeResponse.sanitizedImage,

        // Detection geometry only.
        // No PII values.
        detections:
            safeDetections,

        // Safe DOM metadata.
        dom_elements:
            safeDomElements,

        viewport:
            sanitizeResponse.viewport ||
            prepareResponse.viewport ||
            null,

        // URL without query parameters or fragments.
        page_url:
            getPrivacySafePageUrl(
                tab.url
            ),

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
// FAST planner returns:
//
// {
//     "action": "click",
//     "x": 604,
//     "y": 310,
//     "text": "",
//     "amount": 0,
//     "confidence": 0.98,
//     "reason": "Matched Full Name"
// }
//
// content.js expects:
//
// {
//     "type": "click",
//     "target": {
//         "x": 604,
//         "y": 310
//     }
// }
// ============================================================

function normalizeBrowserAction(action) {


    // ========================================================
    // INVALID ACTION
    // ========================================================

    if (
        !action ||
        typeof action !== "object"
    ) {

        console.warn(
            "[ACTION] Invalid AI action received."
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

    if (
        action.type
    ) {

        console.log(
            "[ACTION] Action already normalized:",
            getSafeActionLog(action)
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
        "[ACTION] Planner action:",
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

            // IMPORTANT:
            // The actual value is retained internally for execution.
            // It is NEVER logged.
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
        "[ACTION] Unsupported AI action:",
        actionName
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

    // ========================================================
    // PRIVACY-SAFE ACTION LOG
    // ========================================================
    //
    // DO NOT replace this with:
    //
    // console.log(action)
    //
    // because type actions may contain sensitive text.
    // ========================================================

    console.log(
        "[ACTION]",
        getSafeActionLog(action)
    );


    // ========================================================
    // NORMALIZE ACTION
    // ========================================================

    const normalizedAction =
        normalizeBrowserAction(
            action
        );


    // ========================================================
    // SAFE NORMALIZED ACTION LOG
    // ========================================================

    console.log(
        "[ACTION] Normalized:",
        getSafeActionLog(
            normalizedAction
        )
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
            "[ACTION] Sending action to content script."
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
            "[ACTION] Action execution failed:",
            error?.message || error
        );

        throw new Error(
            "Could not communicate with content script: " +
            (error?.message || "Unknown error")
        );
    }


    // ========================================================
    // LOG RESULT SAFELY
    // ========================================================
    //
    // Do NOT dump the complete response object.
    //
    // A future content script response might contain sensitive
    // information.
    // ========================================================

    console.log(
        "[ACTION] Content script execution:",
        {
            success:
                response?.success === true,

            action:
                response?.action ||
                normalizedAction.type ||
                "none",

            error:
                response?.error
                    ? String(response.error)
                    : undefined
        }
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
            "[MESSAGE]",
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
                            "[CAPTURE] Capture + sanitize complete."
                        );


                        sendResponse(
                            result
                        );
                    }
                )

                .catch(
                    error => {

                        console.error(
                            "[CAPTURE] Pipeline error:",
                            error?.message || error
                        );


                        sendResponse({

                            success:
                                false,

                            error:
                                error?.message ||
                                "Capture pipeline failed."
                        });
                    }
                );


            // Keep the message channel open for
            // asynchronous response.

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
                "[ACTION] EXECUTE_BROWSER_ACTION received:",
                getSafeActionLog(
                    message.action
                )
            );


            executeBrowserAction(
                message.action
            )

                .then(
                    result => {

                        console.log(
                            "[ACTION] Browser action completed:",
                            {
                                success:
                                    result?.success !== false
                            }
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
                            "[ACTION] Browser action error:",
                            error?.message || error
                        );


                        sendResponse({

                            success:
                                false,

                            error:
                                error?.message ||
                                "Browser action failed."
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
            "[MESSAGE] Unknown background message:",
            message?.type
        );


        return false;
    }
);