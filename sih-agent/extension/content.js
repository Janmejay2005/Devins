console.log("🔒 SIH Privacy Agent loaded");


/* =========================================================
   GLOBAL STATE
   ========================================================= */

let privacyDetections = [];
let privacyOverlays = [];


/* =========================================================
   1. DOM PII DETECTION
   ========================================================= */

function detectDOMPII() {

    const detections = [];

    const elements = document.querySelectorAll(
        "input, textarea, select"
    );

    elements.forEach((element) => {

        const type =
            (element.getAttribute("type") || "").toLowerCase();

        const autocomplete =
            (element.getAttribute("autocomplete") || "").toLowerCase();

        const name =
            (element.getAttribute("name") || "").toLowerCase();

        const id =
            (element.getAttribute("id") || "").toLowerCase();


        let piiType = null;
        let confidence = 0;


        // PASSWORD
        if (type === "password") {

            piiType = "PASSWORD";
            confidence = 1.0;

        }


        // EMAIL
        else if (
            type === "email" ||
            autocomplete.includes("email") ||
            name.includes("email") ||
            id.includes("email")
        ) {

            piiType = "EMAIL";
            confidence = 0.95;

        }


        // PHONE
        else if (
            type === "tel" ||
            autocomplete.includes("tel") ||
            name.includes("phone") ||
            name.includes("mobile") ||
            id.includes("phone") ||
            id.includes("mobile")
        ) {

            piiType = "PHONE";
            confidence = 0.95;

        }


        // CREDIT CARD
        else if (
            autocomplete.includes("cc-number") ||
            name.includes("card") ||
            id.includes("card")
        ) {

            piiType = "CARD";
            confidence = 0.95;

        }


        if (piiType) {

            detections.push({

                type: piiType,

                confidence: confidence,

                source: "DOM",

                target: element

            });

        }

    });


    return detections;

}


/* =========================================================
   2. TEXT PII DETECTION
   ========================================================= */

function detectTextPII() {

    const detections = [];

    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
    );


    const textNodes = [];

    while (walker.nextNode()) {

        const node = walker.currentNode;

        // Don't scan our own privacy overlays
        if (
            node.parentElement &&
            node.parentElement.closest(".sih-privacy-overlay")
        ) {
            continue;
        }

        textNodes.push(node);
    }


    const patterns = [

        {
            type: "AADHAAR",
            regex: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
            confidence: 0.98
        },

        {
            type: "PAN",
            regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
            confidence: 0.98
        },

        {
            type: "EMAIL",
            regex: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/gi,
            confidence: 0.95
        },

        {
            type: "PHONE",
            regex: /(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
            confidence: 0.95
        },

        {
            type: "CARD",
            regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
            confidence: 0.98
        }

    ];


    textNodes.forEach((node) => {

        const text = node.textContent || "";

        if (!text.trim()) {
            return;
        }


        patterns.forEach((pattern) => {

            pattern.regex.lastIndex = 0;

            let match;


            while (
                (match = pattern.regex.exec(text)) !== null
            ) {

                const range = document.createRange();


                range.setStart(
                    node,
                    match.index
                );


                range.setEnd(
                    node,
                    match.index + match[0].length
                );


                const rect =
                    range.getBoundingClientRect();


                if (
                    rect.width > 0 &&
                    rect.height > 0
                ) {

                    detections.push({

                        type: pattern.type,

                        confidence: pattern.confidence,

                        source: "TEXT",

                        target: range

                    });

                }

            }

        });

    });


    return detections;

}


/* =========================================================
   3. GET TARGET RECTANGLE
   ========================================================= */

function getDetectionRect(detection) {

    if (detection.source === "DOM") {

        return detection.target.getBoundingClientRect();

    }


    if (detection.source === "TEXT") {

        return detection.target.getBoundingClientRect();

    }


    return null;

}


/* =========================================================
   4. CREATE OVERLAY
   ========================================================= */

function createPrivacyOverlay(detection) {

    const overlay =
        document.createElement("div");


    overlay.className =
        "sih-privacy-overlay";


    overlay.dataset.type =
        detection.type;


    overlay.style.position =
        "fixed";


    overlay.style.background =
        "#111827";


    overlay.style.color =
        "white";


    overlay.style.display =
        "flex";


    overlay.style.alignItems =
        "center";


    overlay.style.justifyContent =
        "center";


    overlay.style.fontFamily =
        "Arial, sans-serif";


    overlay.style.fontWeight =
        "bold";


    overlay.style.fontSize =
        "13px";


    overlay.style.border =
        "2px solid #ef4444";


    overlay.style.borderRadius =
        "7px";


    overlay.style.zIndex =
        "2147483647";


    overlay.style.pointerEvents =
        "none";


    overlay.style.boxSizing =
        "border-box";


    overlay.style.whiteSpace =
        "nowrap";


    overlay.textContent =
        `🔒 ${detection.type} REDACTED`;


    document.body.appendChild(overlay);


    privacyOverlays.push({

        overlay: overlay,

        detection: detection

    });


    updateOverlayPosition(
        overlay,
        detection
    );

}


/* =========================================================
   5. UPDATE ONE OVERLAY
   ========================================================= */

function updateOverlayPosition(
    overlay,
    detection
) {

    const rect =
        getDetectionRect(detection);


    if (!rect) {
        return;
    }


    let x = rect.left;
    let y = rect.top;
    let width = rect.width;
    let height = rect.height;


    /*
     * DOM elements:
     * Cover the complete input.
     */

    if (detection.source === "DOM") {

        overlay.style.left =
            `${x}px`;

        overlay.style.top =
            `${y}px`;

        overlay.style.width =
            `${width}px`;

        overlay.style.height =
            `${height}px`;

        return;

    }


    /*
     * TEXT detections:
     * Give the small text match a comfortable
     * redaction area so the label does not overlap.
     */

    const paddingX = 8;
    const paddingY = 5;


    x -= paddingX;

    y -= paddingY;

    width += paddingX * 2;

    height += paddingY * 2;


    overlay.style.left =
        `${x}px`;

    overlay.style.top =
        `${y}px`;

    overlay.style.width =
        `${width}px`;

    overlay.style.height =
        `${Math.max(height, 26)}px`;


    /*
     * If the text itself is too small to display
     * the complete label, show a compact label.
     */

    if (width < 150) {

        overlay.textContent =
            `🔒 ${detection.type}`;

    }

}


/* =========================================================
   6. UPDATE ALL OVERLAYS
   ========================================================= */

function updateAllOverlayPositions() {

    privacyOverlays.forEach((item) => {

        updateOverlayPosition(
            item.overlay,
            item.detection
        );

    });

}


/* =========================================================
   7. REMOVE OLD OVERLAYS
   ========================================================= */

function removePrivacyOverlays() {

    privacyOverlays.forEach((item) => {

        item.overlay.remove();

    });


    privacyOverlays = [];

}


/* =========================================================
   8. RUN PRIVACY ENGINE ONCE
   ========================================================= */

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
        privacyDetections.map((detection) => ({

            type: detection.type,

            confidence: detection.confidence,

            source: detection.source

        }))

    );


    privacyDetections.forEach(
        (detection) => {

            createPrivacyOverlay(
                detection
            );

        }
    );


    console.log(
        `🛡️ Privacy overlays created: ${privacyDetections.length}`
    );

}


/* =========================================================
   9. START ONCE
   ========================================================= */

runPrivacyEngine();


/* =========================================================
   10. HANDLE SCROLL WITHOUT RE-DETECTING
   ========================================================= */

let scrollUpdatePending = false;


window.addEventListener(
    "scroll",
    () => {

        if (scrollUpdatePending) {
            return;
        }


        scrollUpdatePending = true;


        requestAnimationFrame(() => {

            updateAllOverlayPositions();

            scrollUpdatePending = false;

        });

    },
    { passive: true }
);


/* =========================================================
   11. HANDLE RESIZE WITHOUT RE-DETECTING
   ========================================================= */

let resizeUpdatePending = false;


window.addEventListener(
    "resize",
    () => {

        if (resizeUpdatePending) {
            return;
        }


        resizeUpdatePending = true;


        requestAnimationFrame(() => {

            updateAllOverlayPositions();

            resizeUpdatePending = false;

        });

    }
);
/* =========================================================
   SCREENSHOT PRIVACY PIPELINE
   ========================================================= */


/*
 * Convert our internal detections into
 * serializable bounding boxes.
 */

function getSerializableDetections() {

    return privacyDetections.map(
        (detection) => {

            const rect =
                getDetectionRect(detection);


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

        }
    ).filter(Boolean);

}


/*
 * Prepare page before screenshot.
 *
 * Remove visual overlays so that
 * we capture the ORIGINAL webpage.
 *
 * The screenshot is still local.
 */

chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {


        if (
            message.type ===
            "PREPARE_CAPTURE"
        ) {

            /*
             * Save detections first.
             */

            const detections =
                getSerializableDetections();


            /*
             * Remove demo overlays.
             */

            removePrivacyOverlays();


            console.log(
                "📐 Capture prepared with",
                detections.length,
                "PII regions"
            );


            sendResponse({

                success: true,

                detections:
                    detections

            });


            return;

        }


        if (
            message.type ===
            "SANITIZE_SCREENSHOT"
        ) {

            sanitizeScreenshot(
                message.screenshot,
                message.detections
            )
            .then((sanitizedImage) => {

                /*
                 * Restore visual overlays
                 * after sanitization.
                 */

                runPrivacyEngine();


                sendResponse({

                    success: true,

                    sanitizedImage:
                        sanitizedImage

                });

            })
            .catch((error) => {

                runPrivacyEngine();


                sendResponse({

                    success: false,

                    error: error.message

                });

            });


            return true;

        }

    }
);


/* =========================================================
   CANVAS SANITIZATION
   ========================================================= */

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


    /*
     * Create canvas matching the
     * actual screenshot resolution.
     */

    const canvas =
        document.createElement("canvas");


    canvas.width =
        image.naturalWidth;


    canvas.height =
        image.naturalHeight;


    const ctx =
        canvas.getContext("2d");


    /*
     * Draw original screenshot
     * locally.
     */

    ctx.drawImage(
        image,
        0,
        0
    );


    /*
     * Screenshot pixels may be larger
     * than CSS pixels because of
     * devicePixelRatio.
     */

    const scaleX =
        canvas.width /
        window.innerWidth;


    const scaleY =
        canvas.height /
        window.innerHeight;


    /*
     * Black-box every detected region.
     */

    detections.forEach(
        (detection) => {

            const x =
                Math.max(
                    0,
                    detection.x * scaleX
                );


            const y =
                Math.max(
                    0,
                    detection.y * scaleY
                );


            const width =
                Math.min(
                    canvas.width - x,
                    detection.width * scaleX
                );


            const height =
                Math.min(
                    canvas.height - y,
                    detection.height * scaleY
                );


            if (
                width <= 0 ||
                height <= 0
            ) {

                return;

            }


            /*
             * Actual pixel redaction.
             */

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


    /*
     * Convert to PNG.
     *
     * This is the SANITIZED image.
     */

    return canvas.toDataURL(
        "image/png"
    );

}