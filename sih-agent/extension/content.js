// ============================================================
// SIH PRIVACY BROWSER AGENT
// On-device PII detection + visual redaction + action execution
// ============================================================

console.log("🔐 SIH Privacy Agent loaded");

// ============================================================
// GLOBAL STATE
// ============================================================

let privacyDetections = [];
let privacyOverlays = [];

let privacyEngineRunning = false;
let privacyRunTimer = null;

// ============================================================
// PII REGEX PATTERNS
// ============================================================

const PII_PATTERNS = {

    // Email
    EMAIL:
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,

    // Indian mobile numbers
    PHONE:
        /(?:\+91[\s-]?)?[6-9]\d{9}\b/g,

    // Aadhaar:
    // Exactly 12 digits, optionally separated into groups.
    //
    // IMPORTANT:
    // Negative digit boundaries prevent matching a 12-digit
    // portion of a longer phone/card number.
    AADHAAR:
        /(?<![+\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,

    // PAN
    PAN:
        /\b[A-Z]{5}\d{4}[A-Z]\b/gi,

    // Credit/debit card candidate
    CREDIT_CARD:
        /\b(?:\d[\s-]*?){13,19}\b/g
};

// ============================================================
// UTILITY
// ============================================================

function normalizeDigits(value) {

    return String(value || "")
        .replace(/\D/g, "");
}


// ============================================================
// VISIBILITY CHECK
// ============================================================

function isVisibleElement(element) {

    if (!element) {
        return false;
    }

    const style =
        window.getComputedStyle(element);

    if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
    ) {
        return false;
    }

    const rect =
        element.getBoundingClientRect();

    return (
        rect.width > 0 &&
        rect.height > 0
    );
}


// ============================================================
// CREDIT CARD VALIDATION
// ============================================================

function isValidCreditCard(value) {

    const digits =
        normalizeDigits(value);

    if (
        digits.length < 13 ||
        digits.length > 19
    ) {
        return false;
    }

    // Luhn algorithm
    let sum = 0;
    let shouldDouble = false;

    for (
        let i = digits.length - 1;
        i >= 0;
        i--
    ) {

        let digit =
            Number(digits[i]);

        if (shouldDouble) {

            digit *= 2;

            if (digit > 9) {
                digit -= 9;
            }
        }

        sum += digit;

        shouldDouble =
            !shouldDouble;
    }

    return sum % 10 === 0;
}


// ============================================================
// AADHAAR VALIDATION
// ============================================================

function isAadhaarCandidate(
    text,
    match
) {

    const matchStart =
        match.index;

    const matchEnd =
        match.index +
        match[0].length;

    // --------------------------------------------------------
    // Find the complete numeric token surrounding the match.
    // This prevents a 12-digit substring inside a longer number
    // from being treated as Aadhaar.
    // --------------------------------------------------------

    let start =
        matchStart;

    let end =
        matchEnd;

    while (
        start > 0 &&
        /[\d\s-]/.test(
            text[start - 1]
        )
    ) {
        start--;
    }

    while (
        end < text.length &&
        /[\d\s-]/.test(
            text[end]
        )
    ) {
        end++;
    }

    const surroundingToken =
        text.substring(
            start,
            end
        );

    const surroundingDigits =
        normalizeDigits(
            surroundingToken
        );

    // Aadhaar must be exactly 12 digits.
    if (
        surroundingDigits.length !== 12
    ) {
        return false;
    }

    // --------------------------------------------------------
    // Do not allow +91 to become part of Aadhaar.
    // --------------------------------------------------------

    const before =
        text.substring(
            Math.max(
                0,
                matchStart - 3
            ),
            matchStart
        );

    if (
        before.endsWith("+91")
    ) {
        return false;
    }

    return true;
}


// ============================================================
// DETECTION RECTANGLE FOR ELEMENT
// ============================================================

function getDetectionRectForElement(
    element
) {

    if (!element) {
        return null;
    }

    try {

        const rect =
            element.getBoundingClientRect();

        if (
            rect.width <= 0 ||
            rect.height <= 0
        ) {
            return null;
        }

        return {

            left:
                rect.left,

            top:
                rect.top,

            right:
                rect.right,

            bottom:
                rect.bottom,

            width:
                rect.width,

            height:
                rect.height
        };

    } catch {

        return null;
    }
}


// ============================================================
// RECTANGLE OVERLAP
// ============================================================

function rectanglesOverlap(
    a,
    b
) {

    if (!a || !b) {
        return false;
    }

    const horizontal =
        a.left < b.right &&
        a.right > b.left;

    const vertical =
        a.top < b.bottom &&
        a.bottom > b.top;

    return (
        horizontal &&
        vertical
    );
}


// ============================================================
// ADD DETECTION
// ============================================================

function addDetection({

    type,
    confidence,
    source,
    element,
    value,
    node = null

}) {

    if (!element) {
        return;
    }

    const normalizedValue =

        type === "PASSWORD"

            ? "[REDACTED]"

            : String(value || "")
                .trim()
                .replace(/\s+/g, " ");

    const rect =
        getDetectionRectForElement(
            element
        );

    // --------------------------------------------------------
    // Prevent duplicate detections.
    //
    // Same type + same value + same/overlapping region
    // means it is the same PII entity.
    // --------------------------------------------------------

    const duplicate =
        privacyDetections.some(
            (existing) => {

                if (
                    existing.type !==
                    type
                ) {
                    return false;
                }

                const existingValue =

                    existing.type ===
                    "PASSWORD"

                        ? "[REDACTED]"

                        : String(
                            existing.value ||
                            ""
                        )
                            .trim()
                            .replace(
                                /\s+/g,
                                " "
                            );

                if (
                    existingValue !==
                    normalizedValue
                ) {
                    return false;
                }

                // Same element
                if (
                    existing.element ===
                    element
                ) {
                    return true;
                }

                // Same visual region
                const existingRect =
                    getDetectionRectForElement(
                        existing.element
                    );

                if (
                    !rect ||
                    !existingRect
                ) {
                    return false;
                }

                return rectanglesOverlap(
                    rect,
                    existingRect
                );
            }
        );

    if (duplicate) {
        return;
    }

    privacyDetections.push({

        type,

        confidence,

        source,

        element,

        value:
            normalizedValue,

        node
    });
}


// ============================================================
// DETECT PII INSIDE TEXT
// ============================================================

function detectPIIPatterns(

    text,

    element,

    source = "dom",

    node = null

) {

    if (
        !text ||
        !element
    ) {
        return;
    }

    const cleanText =
        String(text);

    let match;


    // ========================================================
    // EMAIL
    // ========================================================

    const emailRegex =
        new RegExp(
            PII_PATTERNS.EMAIL.source,
            "gi"
        );

    while (
        (
            match =
                emailRegex.exec(
                    cleanText
                )
        ) !== null
    ) {

        addDetection({

            type:
                "EMAIL",

            confidence:
                0.99,

            source,

            element,

            value:
                match[0],

            node
        });
    }


    // ========================================================
    // PHONE
    // ========================================================

    const phoneRegex =
        new RegExp(
            PII_PATTERNS.PHONE.source,
            "g"
        );

    while (
        (
            match =
                phoneRegex.exec(
                    cleanText
                )
        ) !== null
    ) {

        addDetection({

            type:
                "PHONE",

            confidence:
                0.99,

            source,

            element,

            value:
                match[0],

            node
        });
    }


    // ========================================================
    // AADHAAR
    // ========================================================

    const aadhaarRegex =
        new RegExp(
            PII_PATTERNS.AADHAAR.source,
            "g"
        );

    while (
        (
            match =
                aadhaarRegex.exec(
                    cleanText
                )
        ) !== null
    ) {

        if (
            isAadhaarCandidate(
                cleanText,
                match
            )
        ) {

            addDetection({

                type:
                    "AADHAAR",

                confidence:
                    0.99,

                source,

                element,

                value:
                    match[0],

                node
            });
        }
    }


    // ========================================================
    // PAN
    // ========================================================

    const panRegex =
        new RegExp(
            PII_PATTERNS.PAN.source,
            "gi"
        );

    while (
        (
            match =
                panRegex.exec(
                    cleanText
                )
        ) !== null
    ) {

        addDetection({

            type:
                "PAN",

            confidence:
                0.99,

            source,

            element,

            value:
                match[0],

            node
        });
    }


    // ========================================================
    // CREDIT CARD
    // ========================================================

    const cardRegex =
        new RegExp(
            PII_PATTERNS.CREDIT_CARD.source,
            "g"
        );

    while (
        (
            match =
                cardRegex.exec(
                    cleanText
                )
        ) !== null
    ) {

        if (
            isValidCreditCard(
                match[0]
            )
        ) {

            addDetection({

                type:
                    "CREDIT_CARD",

                confidence:
                    0.99,

                source,

                element,

                value:
                    match[0],

                node
            });
        }
    }
}


// ============================================================
// DOM PII DETECTION
// ============================================================

function detectDOMPII() {

    // Start completely fresh
    privacyDetections = [];

    if (!document.body) {
        return [];
    }


    // ========================================================
    // 1. NORMAL PAGE TEXT
    // ========================================================

    const walker =
        document.createTreeWalker(

            document.body,

            NodeFilter.SHOW_TEXT
        );

    let node;

    while (
        (
            node =
                walker.nextNode()
        )
    ) {

        const text =
            node.textContent?.trim();

        if (!text) {
            continue;
        }

        const parent =
            node.parentElement;

        if (!parent) {
            continue;
        }

        const tag =
            parent.tagName?.toUpperCase();

        // Ignore implementation elements
        if (
            tag === "SCRIPT" ||
            tag === "STYLE" ||
            tag === "NOSCRIPT"
        ) {
            continue;
        }

        if (
            !isVisibleElement(
                parent
            )
        ) {
            continue;
        }

        detectPIIPatterns(

            text,

            parent,

            "dom",

            node
        );
    }


    // ========================================================
    // 2. INPUT + TEXTAREA VALUES
    //
    // input.value is NOT included in textContent.
    // This is why form PII needs a separate scan.
    // ========================================================

    const fields =
        document.querySelectorAll(
            "input, textarea"
        );

    fields.forEach(
        (field) => {

            if (
                !isVisibleElement(
                    field
                )
            ) {
                return;
            }


            // ------------------------------------------------
            // PASSWORD
            // ------------------------------------------------

            if (

                field.tagName ===
                    "INPUT" &&

                field.type
                    ?.toLowerCase() ===
                    "password"

            ) {

                addDetection({

                    type:
                        "PASSWORD",

                    confidence:
                        1.0,

                    source:
                        "input",

                    element:
                        field,

                    value:
                        "[REDACTED]"
                });

                return;
            }


            // ------------------------------------------------
            // INPUT/TEXTAREA VALUE
            // ------------------------------------------------

            const value =
                field.value?.trim();

            if (!value) {
                return;
            }

            detectPIIPatterns(

                value,

                field,

                "input"
            );
        }
    );


    // ========================================================
    // LOG
    // ========================================================

    console.log(

        "🔍 Local PII detections:",

        privacyDetections.length,

        privacyDetections.map(
            (detection) => ({

                type:
                    detection.type,

                source:
                    detection.source,

                confidence:
                    detection.confidence
            })
        )
    );

    return privacyDetections;
}


// ============================================================
// GET DETECTION RECTANGLE
// ============================================================

function getDetectionRect(
    detection
) {

    if (!detection) {
        return null;
    }

    const element =
        detection.element;

    if (!element) {
        return null;
    }


    // --------------------------------------------------------
    // HTMLElement
    // --------------------------------------------------------

    if (
        element instanceof
        HTMLElement
    ) {

        const rect =
            element.getBoundingClientRect();

        if (
            rect.width > 0 &&
            rect.height > 0
        ) {

            return {

                left:
                    rect.left,

                top:
                    rect.top,

                width:
                    rect.width,

                height:
                    rect.height
            };
        }
    }


    // --------------------------------------------------------
    // Text node
    // --------------------------------------------------------

    if (detection.node) {

        try {

            const range =
                document.createRange();

            range.selectNodeContents(
                detection.node
            );

            const rect =
                range.getBoundingClientRect();

            if (
                rect.width > 0 &&
                rect.height > 0
            ) {

                return {

                    left:
                        rect.left,

                    top:
                        rect.top,

                    width:
                        rect.width,

                    height:
                        rect.height
                };
            }

        } catch (error) {

            console.warn(

                "⚠️ Could not calculate text rect:",

                error
            );
        }
    }

    return null;
}


// ============================================================
// CREATE PRIVACY OVERLAY
// ============================================================

function createPrivacyOverlay(
    detection
) {

    const rect =
        getDetectionRect(
            detection
        );

    if (!rect) {
        return null;
    }

    const overlay =
        document.createElement(
            "div"
        );

    overlay.dataset
        .sihPrivacyOverlay =
        "true";

    overlay.dataset.piiType =
        detection.type;

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

    overlay.style.boxSizing =
        "border-box";

    overlay.style.border =
        "2px solid #000000";

    overlay.style.borderRadius =
        "3px";

    overlay.title =
        `Protected ${detection.type}`;

    document.documentElement.appendChild(
        overlay
    );

    privacyOverlays.push({

        overlay,

        detection
    });

    return overlay;
}


// ============================================================
// UPDATE OVERLAY POSITION
// ============================================================

function updateOverlayPosition(
    item
) {

    const {
        overlay,
        detection
    } = item;

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

    if (!rect) {

        overlay.style.display =
            "none";

        return;
    }

    overlay.style.display =
        "block";

    overlay.style.left =
        `${rect.left}px`;

    overlay.style.top =
        `${rect.top}px`;

    overlay.style.width =
        `${rect.width}px`;

    overlay.style.height =
        `${rect.height}px`;
}


// ============================================================
// UPDATE ALL OVERLAYS
// ============================================================

function updateAllOverlayPositions() {

    privacyOverlays.forEach(
        updateOverlayPosition
    );
}


// ============================================================
// REMOVE OVERLAYS
// ============================================================

function removePrivacyOverlays() {

    privacyOverlays.forEach(
        ({ overlay }) => {

            try {
                overlay.remove();
            } catch {
                // Ignore
            }
        }
    );

    privacyOverlays = [];
}


// ============================================================
// CREATE ALL OVERLAYS
// ============================================================

function createAllPrivacyOverlays() {

    removePrivacyOverlays();

    privacyDetections.forEach(
        (detection) => {

            createPrivacyOverlay(
                detection
            );
        }
    );

    console.log(

        "🛡️ Privacy overlays created:",

        privacyOverlays.length
    );
}


// ============================================================
// MAIN PRIVACY ENGINE
// ============================================================

function runPrivacyEngine() {

    if (
        privacyEngineRunning
    ) {
        return;
    }

    privacyEngineRunning =
        true;

    try {

        detectDOMPII();

        createAllPrivacyOverlays();

    } catch (error) {

        console.error(

            "❌ Privacy engine error:",

            error
        );

    } finally {

        privacyEngineRunning =
            false;
    }
}


// ============================================================
// SCHEDULE PRIVACY ENGINE
// ============================================================

function schedulePrivacyEngine(
    delay = 200
) {

    clearTimeout(
        privacyRunTimer
    );

    privacyRunTimer =
        setTimeout(
            () => {

                runPrivacyEngine();

            },
            delay
        );
}


// ============================================================
// SERIALIZABLE DETECTIONS
// ============================================================

function getSerializableDetections() {

    return privacyDetections

        .map(
            (detection) => {

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
            }
        )

        .filter(Boolean);
}


// ============================================================
// SCREENSHOT SANITIZATION
// ============================================================

async function sanitizeScreenshot(

    screenshot,

    detections

) {

    return new Promise(
        (resolve, reject) => {

            try {

                if (!screenshot) {

                    reject(
                        new Error(
                            "No screenshot received"
                        )
                    );

                    return;
                }

                const image =
                    new Image();

                image.onload =
                    () => {

                        try {

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

                            if (!ctx) {

                                reject(
                                    new Error(
                                        "Could not create canvas context"
                                    )
                                );

                                return;
                            }

                            ctx.drawImage(

                                image,

                                0,

                                0
                            );


                            // ------------------------------------------------
                            // Calculate screenshot scaling.
                            // ------------------------------------------------

                            const scaleX =

                                canvas.width /
                                window.innerWidth;

                            const scaleY =

                                canvas.height /
                                window.innerHeight;


                            // ------------------------------------------------
                            // Redact every detected region.
                            // ------------------------------------------------

                            detections.forEach(
                                (detection) => {

                                    const x =
                                        detection.x *
                                        scaleX;

                                    const y =
                                        detection.y *
                                        scaleY;

                                    const width =
                                        detection.width *
                                        scaleX;

                                    const height =
                                        detection.height *
                                        scaleY;

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


                            // ------------------------------------------------
                            // Convert to sanitized PNG.
                            // ------------------------------------------------

                            const sanitizedImage =
                                canvas.toDataURL(
                                    "image/png"
                                );

                            resolve(
                                sanitizedImage
                            );

                        } catch (error) {

                            reject(error);
                        }
                    };


                image.onerror =
                    () => {

                        reject(
                            new Error(
                                "Failed to load screenshot"
                            )
                        );
                    };


                image.src =
                    screenshot;

            } catch (error) {

                reject(error);
            }
        }
    );
}


// ============================================================
// BROWSER ACTION EXECUTION
// ============================================================

function executeBrowserAction(
    action
) {

    if (!action) {

        return {

            success:
                false,

            error:
                "No action received"
        };
    }

    console.log(

        "🤖 Action received:",

        action
    );

    const actionType =
        action.type;


    // ========================================================
    // CLICK
    // ========================================================

    if (
        actionType ===
        "click"
    ) {

        const target =
            action.target || {};

        const x =
            Number(target.x);

        const y =
            Number(target.y);

        if (

            !Number.isFinite(x) ||

            !Number.isFinite(y)

        ) {

            return {

                success:
                    false,

                error:
                    "Invalid click coordinates"
            };
        }

        console.log(

            "🎯 Click target:",

            x,

            y
        );

        const element =
            document.elementFromPoint(
                x,
                y
            );

        if (!element) {

            return {

                success:
                    false,

                error:
                    `No element found at (${x}, ${y})`
            };
        }


        // ----------------------------------------------------
        // NEVER CLICK PRIVACY OVERLAY
        // ----------------------------------------------------

        if (

            element.dataset &&

            element.dataset
                .sihPrivacyOverlay ===
                "true"

        ) {

            return {

                success:
                    false,

                error:
                    "Click blocked by privacy overlay"
            };
        }


        // ----------------------------------------------------
        // NEVER AUTOMATE PASSWORD FIELD
        // ----------------------------------------------------

        if (

            element.tagName ===
                "INPUT" &&

            element.type
                ?.toLowerCase() ===
                "password"

        ) {

            return {

                success:
                    false,

                error:
                    "Password-field automation blocked"
            };
        }


        // ----------------------------------------------------
        // EXECUTE CLICK
        // ----------------------------------------------------

        try {

            element.click();

            console.log(
                "🖱️ Click executed"
            );

            return {

                success:
                    true,

                action:
                    "click",

                element:
                    element.tagName,

                text:
                    (
                        element.innerText ||

                        element.value ||

                        element.getAttribute(
                            "aria-label"
                        ) ||

                        ""
                    )
                        .trim()
                        .substring(
                            0,
                            100
                        )
            };

        } catch (error) {

            return {

                success:
                    false,

                error:
                    error.message
            };
        }
    }


    // ========================================================
    // TYPE
    // ========================================================

    if (
        actionType ===
        "type"
    ) {

        const target =
            action.target || {};

        const x =
            Number(target.x);

        const y =
            Number(target.y);

        const value =
            action.value;

        if (

            !Number.isFinite(x) ||

            !Number.isFinite(y)

        ) {

            return {

                success:
                    false,

                error:
                    "Invalid typing coordinates"
            };
        }

        const element =
            document.elementFromPoint(
                x,
                y
            );

        if (!element) {

            return {

                success:
                    false,

                error:
                    "No typing target found"
            };
        }

        if (

            element.tagName !==
                "INPUT" &&

            element.tagName !==
                "TEXTAREA"

        ) {

            return {

                success:
                    false,

                error:
                    "Target is not an input field"
            };
        }


        // ----------------------------------------------------
        // NEVER TYPE INTO PASSWORD
        // ----------------------------------------------------

        if (

            element.type
                ?.toLowerCase() ===
                "password"

        ) {

            return {

                success:
                    false,

                error:
                    "Password-field automation blocked"
            };
        }


        // ----------------------------------------------------
        // TYPE VALUE
        // ----------------------------------------------------

        try {

            element.focus();

            element.value =
                String(
                    value ?? ""
                );

            element.dispatchEvent(

                new Event(
                    "input",
                    {
                        bubbles:
                            true
                    }
                )
            );

            element.dispatchEvent(

                new Event(
                    "change",
                    {
                        bubbles:
                            true
                    }
                )
            );

            console.log(

                "⌨️ Text entered successfully"
            );

            return {

                success:
                    true,

                action:
                    "type",

                element:
                    element.tagName
            };

        } catch (error) {

            return {

                success:
                    false,

                error:
                    error.message
            };
        }
    }


    // ========================================================
    // SCROLL
    // ========================================================

    if (
        actionType ===
        "scroll"
    ) {

        const target =
            action.target || {};

        const amount =
            Number(

                target.y ??

                action.value ??

                500
            );

        window.scrollBy({

            top:

                Number.isFinite(
                    amount
                )

                    ? amount

                    : 500,

            left:
                0,

            behavior:
                "smooth"
        });

        return {

            success:
                true,

            action:
                "scroll",

            amount
        };
    }


    // ========================================================
    // WAIT
    // ========================================================

    if (
        actionType ===
        "wait"
    ) {

        const delay =
            Number(
                action.value ||
                1000
            );

        return {

            success:
                true,

            action:
                "wait",

            delay
        };
    }


    // ========================================================
    // NONE
    // ========================================================

    if (
        actionType ===
        "none"
    ) {

        return {

            success:
                true,

            action:
                "none"
        };
    }


    // ========================================================
    // UNKNOWN ACTION
    // ========================================================

    return {

        success:
            false,

        error:
            `Unsupported action type: ${actionType}`
    };
}


// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener(

    (
        message,
        sender,
        sendResponse
    ) => {


        // ====================================================
        // PREPARE CAPTURE
        // ====================================================

        if (
            message.type ===
            "PREPARE_CAPTURE"
        ) {

            // Refresh detections immediately
            runPrivacyEngine();

            const detections =
                getSerializableDetections();

            // Remove overlays before screenshot
            removePrivacyOverlays();

            console.log(

                "📐 Capture prepared with",

                detections.length,

                "PII regions"
            );

            sendResponse({

                success:
                    true,

                detections
            });

            return;
        }


        // ====================================================
        // SANITIZE SCREENSHOT
        // ====================================================

        if (
            message.type ===
            "SANITIZE_SCREENSHOT"
        ) {

            sanitizeScreenshot(

                message.screenshot,

                message.detections ||
                    []
            )

                .then(

                    (sanitizedImage) => {

                        // Restore privacy overlays
                        runPrivacyEngine();

                        sendResponse({

                            success:
                                true,

                            sanitizedImage
                        });
                    }
                )

                .catch(

                    (error) => {

                        runPrivacyEngine();

                        sendResponse({

                            success:
                                false,

                            error:
                                error.message
                        });
                    }
                );

            // Async response
            return true;
        }


        // ====================================================
        // EXECUTE ACTION
        // ====================================================

        if (
            message.type ===
            "EXECUTE_ACTION"
        ) {

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


// ============================================================
// SCROLL EVENT
// ============================================================

window.addEventListener(

    "scroll",

    () => {

        updateAllOverlayPositions();

    },

    {
        passive:
            true
    }
);


// ============================================================
// RESIZE EVENT
// ============================================================

window.addEventListener(

    "resize",

    () => {

        updateAllOverlayPositions();

    }
);


// ============================================================
// INPUT EVENT
// ============================================================

document.addEventListener(

    "input",

    () => {

        schedulePrivacyEngine(
            150
        );

    },

    true
);


// ============================================================
// MUTATION OBSERVER
// ============================================================
//
// Important:
// Our own privacy overlays modify the DOM.
// We must NOT continuously rerun the privacy engine
// because of our own overlay creation/removal.
// ============================================================

function mutationContainsOnlyPrivacyOverlays(
    mutation
) {

    const nodes = [

        ...Array.from(
            mutation.addedNodes || []
        ),

        ...Array.from(
            mutation.removedNodes || []
        )
    ];

    if (
        nodes.length === 0
    ) {

        return false;
    }

    return nodes.every(
        (node) => {

            // Text nodes are not privacy overlays.
            if (
                node.nodeType !==
                Node.ELEMENT_NODE
            ) {

                return true;
            }

            return (

                node.dataset &&

                node.dataset
                    .sihPrivacyOverlay ===
                    "true"
            );
        }
    );
}


const privacyObserver =
    new MutationObserver(

        (mutations) => {

            const relevantMutation =
                mutations.some(
                    (mutation) => {

                        return (

                            !mutationContainsOnlyPrivacyOverlays(
                                mutation
                            )
                        );
                    }
                );

            if (!relevantMutation) {
                return;
            }

            schedulePrivacyEngine(
                250
            );
        }
    );


privacyObserver.observe(

    document.documentElement,

    {

        childList:
            true,

        subtree:
            true
    }
);


// ============================================================
// INITIAL RUN
// ============================================================

if (

    document.readyState ===
    "loading"

) {

    document.addEventListener(

        "DOMContentLoaded",

        () => {

            runPrivacyEngine();

        },

        {
            once:
                true
        }
    );

} else {

    runPrivacyEngine();
}