// =========================================================
// SIH PRIVACY BROWSER AGENT
// CONTENT SCRIPT
// Day 2.2
// =========================================================

console.log("🔒 SIH Privacy Agent loaded");


// =========================================================
// GLOBAL STATE
// =========================================================

let privacyDetections = [];
let privacyOverlays = [];


// =========================================================
// PII REGEX
// =========================================================

const PII_PATTERNS = {

    EMAIL:
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,

    PHONE:
        /(?:\+91[\s-]?)?[6-9]\d{9}\b/g,

    AADHAAR:
        /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,

    PAN:
        /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,

    CARD:
        /\b(?:\d{4}[\s-]?){3}\d{4}\b/g
};


// =========================================================
// DOM PII DETECTION
// =========================================================

function detectDOMPII() {

    const detections = [];

    const inputs =
        document.querySelectorAll(
            "input, textarea"
        );


    inputs.forEach((input) => {

        const type =
            (input.type || "").toLowerCase();


        if (
            type === "password"
        ) {

            detections.push({

                type: "PASSWORD",

                source: "DOM",

                confidence: 0.99,

                element: input

            });

        }

    });


    return detections;

}


// =========================================================
// TEXT PII DETECTION
// =========================================================

function detectTextPII() {

    const detections = [];

    const walker =
        document.createTreeWalker(

            document.body,

            NodeFilter.SHOW_TEXT

        );


    const textNodes = [];


    while (walker.nextNode()) {

        textNodes.push(
            walker.currentNode
        );

    }


    textNodes.forEach((node) => {

        const text =
            node.textContent || "";


        Object.entries(
            PII_PATTERNS
        ).forEach(
            ([type, pattern]) => {

                pattern.lastIndex = 0;


                let match;


                while (
                    (match =
                        pattern.exec(text))
                ) {

                    detections.push({

                        type,

                        source: "TEXT",

                        confidence: 0.97,

                        node,

                        index:
                            match.index,

                        length:
                            match[0].length

                    });

                }

            }
        );

    });


    return detections;

}


// =========================================================
// GET ELEMENT RECT
// =========================================================

function getDetectionRect(
    detection
) {

    if (
        detection.element
    ) {

        return detection.element
            .getBoundingClientRect();

    }


    if (
        detection.node
    ) {

        const range =
            document.createRange();


        try {

            range.setStart(
                detection.node,
                detection.index
            );


            range.setEnd(
                detection.node,
                detection.index +
                detection.length
            );


            return range.getBoundingClientRect();

        } catch (error) {

            console.warn(
                "Could not calculate text rect",
                error
            );

        }

    }


    return null;

}


// =========================================================
// CREATE PRIVACY OVERLAY
// =========================================================

function createPrivacyOverlay(
    detection
) {

    const rect =
        getDetectionRect(
            detection
        );


    if (
        !rect ||
        rect.width <= 0 ||
        rect.height <= 0
    ) {

        return null;

    }


    const overlay =
        document.createElement(
            "div"
        );


    overlay.dataset.sihPrivacyOverlay =
        "true";


    overlay.style.position =
        "fixed";

    overlay.style.left =
        `${rect.left}px`;

    overlay.style.top =
        `${rect.top}px`;

    overlay.style.width =
        `${rect.width}px`;

    overlay.style.height =
        `${rect.height}px`;

    overlay.style.background =
        "#000000";

    overlay.style.zIndex =
        "2147483647";

    overlay.style.pointerEvents =
        "none";

    overlay.style.borderRadius =
        "2px";


    document.body.appendChild(
        overlay
    );


    return overlay;

}


// =========================================================
// UPDATE OVERLAY POSITION
// =========================================================

function updateOverlayPosition(
    overlay,
    detection
) {

    if (
        !overlay ||
        !detection
    ) {

        return;

    }


    const rect =
        getDetectionRect(
            detection
        );


    if (
        !rect
    ) {

        return;

    }


    overlay.style.left =
        `${rect.left}px`;

    overlay.style.top =
        `${rect.top}px`;

    overlay.style.width =
        `${rect.width}px`;

    overlay.style.height =
        `${rect.height}px`;

}


// =========================================================
// UPDATE ALL OVERLAYS
// =========================================================

function updateAllOverlayPositions() {

    privacyOverlays.forEach(
        (overlay, index) => {

            const detection =
                privacyDetections[index];


            updateOverlayPosition(
                overlay,
                detection
            );

        }
    );

}


// =========================================================
// REMOVE PRIVACY OVERLAYS
// =========================================================

function removePrivacyOverlays() {

    privacyOverlays.forEach(
        (overlay) => {

            overlay.remove();

        }
    );


    privacyOverlays = [];

}


// =========================================================
// RUN PRIVACY ENGINE
// =========================================================

function runPrivacyEngine() {

    removePrivacyOverlays();


    const domDetections =
        detectDOMPII();


    const textDetections =
        detectTextPII();


    privacyDetections = [

        ...domDetections,

        ...textDetections

    ];


    console.log(
        "🔍 Local PII detections:",
        privacyDetections
    );


    privacyOverlays =
        privacyDetections
            .map(
                createPrivacyOverlay
            )
            .filter(Boolean);


    console.log(
        "🛡️ Privacy overlays created:",
        privacyOverlays.length
    );

}


// =========================================================
// SCROLL / RESIZE
// =========================================================

window.addEventListener(
    "scroll",
    updateAllOverlayPositions,
    {
        passive: true
    }
);


window.addEventListener(
    "resize",
    updateAllOverlayPositions
);


// =========================================================
// SERIALIZABLE DETECTIONS
// =========================================================

function getSerializableDetections() {

    return privacyDetections
        .map((detection) => {

            const rect =
                getDetectionRect(
                    detection
                );


            if (!rect) {

                return null;

            }


            return {

                type:
                    detection.type,

                confidence:
                    detection.confidence,

                source:
                    detection.source,

                x:
                    rect.left,

                y:
                    rect.top,

                width:
                    rect.width,

                height:
                    rect.height

            };

        })
        .filter(Boolean);

}


// =========================================================
// SANITIZE SCREENSHOT
// =========================================================

async function sanitizeScreenshot(
    screenshot,
    detections
) {

    const image =
        new Image();


    image.src =
        screenshot;


    await new Promise(
        (resolve, reject) => {

            image.onload =
                resolve;

            image.onerror =
                reject;

        }
    );


    const canvas =
        document.createElement(
            "canvas"
        );


    canvas.width =
        image.naturalWidth;

    canvas.height =
        image.naturalHeight;


    const ctx =
        canvas.getContext(
            "2d"
        );


    ctx.drawImage(
        image,
        0,
        0
    );


    const scaleX =
        canvas.width /
        window.innerWidth;


    const scaleY =
        canvas.height /
        window.innerHeight;


    detections.forEach(
        (detection) => {

            const x =
                Math.max(
                    0,
                    detection.x *
                    scaleX
                );


            const y =
                Math.max(
                    0,
                    detection.y *
                    scaleY
                );


            const width =
                Math.min(
                    canvas.width - x,
                    detection.width *
                    scaleX
                );


            const height =
                Math.min(
                    canvas.height - y,
                    detection.height *
                    scaleY
                );


            if (
                width <= 0 ||
                height <= 0
            ) {

                return;

            }


            ctx.fillStyle =
                "#000000";


            ctx.fillRect(
                x,
                y,
                width,
                height
            );

        }
    );


    return canvas.toDataURL(
        "image/png"
    );

}


// =========================================================
// MESSAGE HANDLER
// =========================================================

chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {

        // =================================================
        // PREPARE CAPTURE
        // =================================================

        if (
            message.type ===
            "PREPARE_CAPTURE"
        ) {

            const detections =
                getSerializableDetections();


            removePrivacyOverlays();


            console.log(
                "📐 Capture prepared with",
                detections.length,
                "PII regions"
            );


            sendResponse({

                success: true,

                detections

            });


            return;

        }


        // =================================================
        // SANITIZE SCREENSHOT
        // =================================================

        if (
            message.type ===
            "SANITIZE_SCREENSHOT"
        ) {

            sanitizeScreenshot(
                message.screenshot,
                message.detections
            )
                .then(
                    (sanitizedImage) => {

                        runPrivacyEngine();


                        sendResponse({

                            success: true,

                            sanitizedImage

                        });

                    }
                )
                .catch(
                    (error) => {

                        runPrivacyEngine();


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
        // DAY 2.2 — EXECUTE ACTION
        // =================================================

        if (
            message.type ===
            "EXECUTE_ACTION"
        ) {

            console.log(
                "🤖 Action received:",
                message.action
            );


            const result =
                executeBrowserAction(
                    message.action
                );


            console.log(
                "✅ Action execution result:",
                result
            );


            sendResponse(
                result
            );


            return;

        }

    }
);


// =========================================================
// ACTION EXECUTOR
// =========================================================

function executeBrowserAction(
    action
) {

    if (
        !action ||
        !action.type
    ) {

        return {

            success: false,

            error:
                "Invalid action"

        };

    }


    // =====================================================
    // CLICK
    // =====================================================

    if (
        action.type ===
        "click"
    ) {

        const target =
            action.target;


        if (
            !target ||
            typeof target.x !==
                "number" ||
            typeof target.y !==
                "number"
        ) {

            return {

                success: false,

                error:
                    "Click action requires x and y"

            };

        }


        const x =
            target.x;


        const y =
            target.y;


        const element =
            document.elementFromPoint(
                x,
                y
            );


        if (!element) {

            return {

                success: false,

                error:
                    `No element found at (${x}, ${y})`

            };

        }


        console.log(
            "🎯 Click target:",
            element
        );


        // -------------------------------------------------
        // Prevent clicking our own privacy overlays
        // -------------------------------------------------

        if (
            element.dataset &&
            element.dataset.sihPrivacyOverlay ===
                "true"
        ) {

            return {

                success: false,

                error:
                    "Click blocked by privacy overlay"

            };

        }


        element.click();


        console.log(
            "🖱️ Click executed"
        );


        return {

            success: true,

            action: "click",

            element:
                element.tagName,

            text:
                (
                    element.innerText ||
                    element.value ||
                    ""
                )
                    .trim()
                    .substring(0, 100)

        };

    }


    // =====================================================
    // TYPE
    // =====================================================

    if (
        action.type ===
        "type"
    ) {

        const target =
            action.target;


        const value =
            action.value;


        if (
            !target ||
            typeof target.x !==
                "number" ||
            typeof target.y !==
                "number"
        ) {

            return {

                success: false,

                error:
                    "Type action requires x and y"

            };

        }


        if (
            typeof value !==
            "string"
        ) {

            return {

                success: false,

                error:
                    "Type action requires value"

            };

        }


        const element =
            document.elementFromPoint(
                target.x,
                target.y
            );


        if (!element) {

            return {

                success: false,

                error:
                    "No element found"

            };

        }


        const tag =
            element.tagName
                .toLowerCase();


        if (
            tag !== "input" &&
            tag !== "textarea"
        ) {

            return {

                success: false,

                error:
                    "Target is not an input"

            };

        }


        if (
            element.type ===
            "password"
        ) {

            return {

                success: false,

                error:
                    "Password-field automation blocked"

            };

        }


        element.focus();


        element.value =
            value;


        element.dispatchEvent(
            new Event(
                "input",
                {
                    bubbles: true
                }
            )
        );


        element.dispatchEvent(
            new Event(
                "change",
                {
                    bubbles: true
                }
            )
        );


        console.log(
            "⌨️ Text entered"
        );


        return {

            success: true,

            action: "type",

            element:
                element.tagName,

            valueLength:
                value.length

        };

    }


    // =====================================================
    // SCROLL
    // =====================================================

    if (
        action.type ===
        "scroll"
    ) {

        const amount =
            typeof action.value ===
                "number"
                ? action.value
                : 500;


        window.scrollBy({

            top:
                amount,

            behavior:
                "smooth"

        });


        return {

            success: true,

            action: "scroll",

            amount

        };

    }


    // =====================================================
    // WAIT
    // =====================================================

    if (
        action.type ===
        "wait"
    ) {

        return {

            success: true,

            action: "wait"

        };

    }


    // =====================================================
    // NONE
    // =====================================================

    if (
        action.type ===
        "none"
    ) {

        return {

            success: true,

            action: "none"

        };

    }


    return {

        success: false,

        error:
            `Unsupported action type: ${action.type}`

    };

}


// =========================================================
// INITIAL RUN
// =========================================================

runPrivacyEngine();