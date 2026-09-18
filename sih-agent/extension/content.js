// ============================================================
// SIH PRIVACY BROWSER AGENT
// content.js
// ============================================================

console.log("🔒 SIH Privacy Agent loaded");


// ============================================================
// CONFIGURATION
// ============================================================

const SIH_CONFIG = {

    overlayColor: "#000000",

    overlayZIndex: 2147483647,

    maxDOMElements: 100,

    mutationDelay: 250,

    inputDelay: 150
};


// ============================================================
// PII PATTERNS
// ============================================================

const PII_PATTERNS = {

    EMAIL:
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,

    PHONE:
        /(?<![\d])(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)/g,

    /*
     * IMPORTANT:
     *
     * Aadhaar must NOT be part of a larger number.
     *
     * This prevents:
     *
     * 4111 1111 1111 1111
     *
     * from being partially detected as Aadhaar.
     */

    AADHAAR:
        /(?<![+\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\d\s-])/g,

    PAN:
        /\b[A-Z]{5}\d{4}[A-Z]\b/gi,

    CREDIT_CARD:
        /\b(?:\d[ -]?){13,19}\b/g
};


// ============================================================
// STATE
// ============================================================

let detections = [];

let privacyOverlays = [];

let privacyEngineRunning = false;

let captureInProgress = false;

let lastDetectionSignature = "";


// ============================================================
// UTILITY
// ============================================================

function normalizeText(text) {

    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}


function isVisible(element) {

    if (!element) {
        return false;
    }

    const style =
        window.getComputedStyle(
            element
        );

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


function getNumericValue(value) {

    return String(value || "")
        .replace(/\D/g, "");
}


// ============================================================
// LUHN CHECK
// ============================================================

function luhnCheck(number) {

    const digits =
        getNumericValue(number);

    if (
        digits.length < 13 ||
        digits.length > 19
    ) {
        return false;
    }

    let sum = 0;

    let alternate = false;

    for (
        let i = digits.length - 1;
        i >= 0;
        i--
    ) {

        let n =
            Number(
                digits[i]
            );

        if (alternate) {

            n *= 2;

            if (n > 9) {
                n -= 9;
            }
        }

        sum += n;

        alternate =
            !alternate;
    }

    alternate =
        !alternate;

    return (
        sum % 10 === 0
    );
}


// ============================================================
// AADHAAR VALIDATION
// ============================================================

function isAadhaarCandidate(
    text,
    match,
    matchIndex
) {

    const digits =
        getNumericValue(match);

    /*
     * Aadhaar must contain exactly 12 digits.
     */

    if (
        digits.length !== 12
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * CHECK BEFORE MATCH
     * --------------------------------------------------------
     *
     * Reject if the match is immediately preceded by:
     *
     * +91
     * another digit
     * digit separator belonging to a larger number
     */

    const before =
        text.slice(
            Math.max(
                0,
                matchIndex - 5
            ),
            matchIndex
        );

    if (
        /\d[\s-]*$/.test(
            before
        )
    ) {
        return false;
    }

    if (
        /\+91[\s-]*$/i.test(
            before
        )
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * CHECK AFTER MATCH
     * --------------------------------------------------------
     *
     * This is the critical fix.
     *
     * For:
     *
     * 4111 1111 1111 1111
     *
     * a 12-digit substring could previously look like:
     *
     * 4111 1111 1111
     *
     * We now reject it because another digit group follows.
     */

    const afterStart =
        matchIndex +
        match.length;

    const after =
        text.slice(
            afterStart,
            afterStart + 6
        );

    if (
        /^\s*[\d]/.test(
            after
        )
    ) {
        return false;
    }


    /*
     * Reject another number separator followed by digits.
     *
     * Example:
     *
     * 4111 1111 1111 1111
     *
     * The match must not stop before the final group.
     */

    if (
        /^\s*[- ]\s*\d/.test(
            after
        )
    ) {
        return false;
    }


    /*
     * --------------------------------------------------------
     * FULL TOKEN CHECK
     * --------------------------------------------------------
     */

    const tokenBefore =
        text.slice(
            Math.max(
                0,
                matchIndex - 20
            ),
            matchIndex
        );

    const tokenAfter =
        text.slice(
            afterStart,
            Math.min(
                text.length,
                afterStart + 20
            )
        );

    const surrounding =
        `${tokenBefore}${match}${tokenAfter}`;

    /*
     * If the surrounding area is clearly a long
     * payment-card-like sequence, reject Aadhaar.
     */

    const surroundingDigits =
        getNumericValue(
            surrounding
        );

    if (
        surroundingDigits.length > 12
    ) {
        return false;
    }


    return true;
}


// ============================================================
// DETECTION DUPLICATE CHECK
// ============================================================

function detectionAlreadyExists(
    type,
    value,
    rect
) {

    return detections.some(
        existing => {

            if (
                existing.type !== type
            ) {
                return false;
            }

            if (
                existing.value === value
            ) {
                return true;
            }

            if (
                !existing.rect ||
                !rect
            ) {
                return false;
            }

            const a =
                existing.rect;

            const b =
                rect;

            const overlap =
                !(
                    a.right < b.left ||
                    a.left > b.right ||
                    a.bottom < b.top ||
                    a.top > b.bottom
                );

            return overlap;
        }
    );
}


// ============================================================
// ADD DETECTION
// ============================================================

function addDetection(
    type,
    value,
    element,
    rect,
    source = "dom"
) {

    if (!value) {
        return;
    }

    const cleanValue =
        String(value);

    if (
        detectionAlreadyExists(
            type,
            cleanValue,
            rect
        )
    ) {
        return;
    }

    detections.push({

        id:
            `${type}-${detections.length + 1}`,

        type,

        value:
            cleanValue,

        source,

        tagName:
            element
                ? element.tagName
                : "",

        rect: rect
            ? {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height
            }
            : null
    });
}


// ============================================================
// REGEX PII DETECTION
// ============================================================

function detectPIIPatterns(
    text,
    element,
    rect,
    source = "text"
) {

    if (!text) {
        return;
    }

    const input =
        String(text);

    let match;


    // ========================================================
    // EMAIL
    // ========================================================

    PII_PATTERNS.EMAIL.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.EMAIL.exec(
                    input
                )
        ) !== null
    ) {

        addDetection(
            "EMAIL",
            match[0],
            element,
            rect,
            source
        );
    }


    // ========================================================
    // PHONE
    // ========================================================

    PII_PATTERNS.PHONE.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.PHONE.exec(
                    input
                )
        ) !== null
    ) {

        addDetection(
            "PHONE",
            match[0],
            element,
            rect,
            source
        );
    }


    // ========================================================
    // AADHAAR
    // ========================================================

    PII_PATTERNS.AADHAAR.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.AADHAAR.exec(
                    input
                )
        ) !== null
    ) {

        const valid =
            isAadhaarCandidate(
                input,
                match[0],
                match.index
            );

        if (valid) {

            addDetection(
                "AADHAAR",
                match[0],
                element,
                rect,
                source
            );
        }
    }


    // ========================================================
    // PAN
    // ========================================================

    PII_PATTERNS.PAN.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.PAN.exec(
                    input
                )
        ) !== null
    ) {

        addDetection(
            "PAN",
            match[0],
            element,
            rect,
            source
        );
    }


    // ========================================================
    // CREDIT CARD
    // ========================================================

    PII_PATTERNS.CREDIT_CARD.lastIndex = 0;

    while (
        (
            match =
                PII_PATTERNS.CREDIT_CARD.exec(
                    input
                )
        ) !== null
    ) {

        if (
            luhnCheck(
                match[0]
            )
        ) {

            addDetection(
                "CREDIT_CARD",
                match[0],
                element,
                rect,
                source
            );
        }
    }
}


// ============================================================
// PASSWORD DETECTION
// ============================================================

function detectPasswordField(
    element
) {

    if (
        !element ||
        element.tagName !== "INPUT"
    ) {
        return;
    }

    if (
        (
            element.type ||
            ""
        ).toLowerCase()
        !== "password"
    ) {
        return;
    }

    const rect =
        element.getBoundingClientRect();

    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        return;
    }

    addDetection(
        "PASSWORD",
        "[REDACTED_PASSWORD]",
        element,
        rect,
        "input"
    );
}


// ============================================================
// DOM PII ENGINE
// ============================================================

function detectDOMPII() {

    resetDetections();


    // ========================================================
    // TEXT NODES
    // ========================================================

    const walker =
        document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT
        );

    const textNodes = [];

    let node;

    while (
        (
            node =
                walker.nextNode()
        )
    ) {

        textNodes.push(
            node
        );
    }


    for (
        const textNode of textNodes
    ) {

        const parent =
            textNode.parentElement;

        if (
            !parent ||
            !isVisible(parent)
        ) {
            continue;
        }

        if (
            parent.closest(
                "[data-sih-privacy-overlay='true']"
            )
        ) {
            continue;
        }

        const text =
            normalizeText(
                textNode.textContent
            );

        if (!text) {
            continue;
        }

        const rect =
            parent.getBoundingClientRect();

        detectPIIPatterns(
            text,
            parent,
            rect,
            "text"
        );
    }


    // ========================================================
    // INPUT / TEXTAREA VALUES
    // ========================================================

    const fields =
        document.querySelectorAll(
            "input, textarea"
        );

    fields.forEach(
        field => {

            if (
                !isVisible(field)
            ) {
                return;
            }


            // Password
            detectPasswordField(
                field
            );


            const rect =
                field.getBoundingClientRect();

            const value =
                field.value || "";


            /*
             * Value is processed ONLY locally.
             *
             * It is NOT added to safe DOM metadata.
             */

            if (value) {

                detectPIIPatterns(
                    value,
                    field,
                    rect,
                    "input-value"
                );
            }
        }
    );


    console.log(
        "🔍 Local PII detections:",
        detections.length,
        detections
    );
}


// ============================================================
// RESET DETECTIONS
// ============================================================

function resetDetections() {

    detections = [];
}


// ============================================================
// SERIALIZABLE DETECTIONS
// ============================================================

function getSerializableDetections() {

    return detections.map(
        detection => ({

            id:
                detection.id,

            type:
                detection.type,

            value:
                detection.value,

            source:
                detection.source,

            tagName:
                detection.tagName,

            rect:
                detection.rect
        })
    );
}


// ============================================================
// SAFE DOM EXTRACTION
// ============================================================

function collectSafeDOM() {

    const elements = [];

    const candidates =
        document.querySelectorAll(
            [
                "button",
                "input",
                "textarea",
                "select",
                "a",
                "label",
                "[role='button']",
                "[role='link']",
                "[aria-label]"
            ].join(",")
        );


    candidates.forEach(
        (element, index) => {

            if (
                elements.length >=
                SIH_CONFIG.maxDOMElements
            ) {
                return;
            }

            if (
                !isVisible(element)
            ) {
                return;
            }

            if (
                element.closest(
                    "[data-sih-privacy-overlay='true']"
                )
            ) {
                return;
            }

            const rect =
                element.getBoundingClientRect();

            if (
                rect.bottom < 0 ||
                rect.right < 0 ||
                rect.top >
                    window.innerHeight ||
                rect.left >
                    window.innerWidth
            ) {
                return;
            }


            const tag =
                element.tagName.toLowerCase();

            const type =
                element.getAttribute(
                    "type"
                ) || "";

            const role =
                element.getAttribute(
                    "role"
                ) || "";

            const ariaLabel =
                element.getAttribute(
                    "aria-label"
                ) || "";

            const name =
                element.getAttribute(
                    "name"
                ) || "";

            const placeholder =
                element.getAttribute(
                    "placeholder"
                ) || "";


            let text = "";

if (
    tag === "button" ||
    tag === "a" ||
    tag === "label" ||
    role === "button" ||
    role === "link"
) {
    text =
        normalizeText(
            element.innerText ||
            element.textContent ||
            ""
        );
}

/*
 * SAFE SUBMIT CONTROL METADATA
 *
 * IMPORTANT:
 * We do NOT read input.value for normal inputs.
 *
 * For button-like input controls only, the HTML
 * value attribute is UI metadata such as:
 *
 *     <input type="submit" value="Submit">
 *
 * This does not expose a user's entered form value.
 */
if (
    tag === "input" &&
    (
        type.toLowerCase() === "submit" ||
        type.toLowerCase() === "button" ||
        type.toLowerCase() === "reset"
    )
) {
    text =
        normalizeText(
            element.getAttribute("value") ||
            ""
        );
}


            /*
             * NEVER send input.value.
             */

            let label =
    ariaLabel ||
    name ||
    placeholder ||
    "";

if (
    tag === "input" &&
    (
        type.toLowerCase() === "submit" ||
        type.toLowerCase() === "button" ||
        type.toLowerCase() === "reset"
    )
) {
    label =
        text ||
        label;
}


            if (
                type.toLowerCase()
                === "password"
            ) {

                label =
                    label.replace(
                        /password/gi,
                        "secure field"
                    );
            }


            elements.push({

                index,

                tag,

                type,

                role,

                label:
                    label.slice(
                        0,
                        120
                    ),

                text:
                    text.slice(
                        0,
                        120
                    ),

                x:
                    Math.round(
                        rect.left
                    ),

                y:
                    Math.round(
                        rect.top
                    ),

                width:
                    Math.round(
                        rect.width
                    ),

                height:
                    Math.round(
                        rect.height
                    )
            });
        }
    );


    console.log(
        "🧩 Safe DOM elements:",
        elements.length
    );

    return elements;
}


// ============================================================
// PRIVACY OVERLAYS
// ============================================================

function removePrivacyOverlays() {

    privacyOverlays.forEach(
        overlay => {

            try {

                overlay.remove();

            } catch (_) {}
        }
    );

    privacyOverlays = [];


    document
        .querySelectorAll(
            "[data-sih-privacy-overlay='true']"
        )
        .forEach(
            element => {

                element.remove();
            }
        );
}


// ============================================================
// CREATE PRIVACY OVERLAY
// ============================================================

function createPrivacyOverlay(
    rect
) {

    if (!rect) {
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
        SIH_CONFIG.overlayColor;

    overlay.style.zIndex =
        SIH_CONFIG.overlayZIndex;

    overlay.style.pointerEvents =
        "none";

    overlay.style.border =
        "1px solid #000";

    overlay.style.boxSizing =
        "border-box";


    document.body.appendChild(
        overlay
    );


    return overlay;
}


// ============================================================
// CREATE ALL PRIVACY OVERLAYS
// ============================================================

function createPrivacyOverlays() {

    removePrivacyOverlays();


    detections.forEach(
        detection => {

            const rect =
                detection.rect;

            if (!rect) {
                return;
            }


            const overlay =
                createPrivacyOverlay(
                    rect
                );


            if (overlay) {

                overlay.__sihRect =
                    rect;

                privacyOverlays.push(
                    overlay
                );
            }
        }
    );


    console.log(
        "🛡️ Privacy overlays created:",
        privacyOverlays.length
    );
}


// ============================================================
// UPDATE OVERLAY POSITIONS
// ============================================================

function updateAllOverlayPositions() {

    privacyOverlays.forEach(
        overlay => {

            if (
                !overlay.__sihRect
            ) {
                return;
            }


            const rect =
                overlay.__sihRect;


            overlay.style.left =
                `${rect.left}px`;

            overlay.style.top =
                `${rect.top}px`;

            overlay.style.width =
                `${rect.width}px`;

            overlay.style.height =
                `${rect.height}px`;
        }
    );
}


// ============================================================
// PRIVACY ENGINE
// ============================================================

function runPrivacyEngine() {

    if (
        privacyEngineRunning
    ) {
        return;
    }


    privacyEngineRunning = true;


    try {

        detectDOMPII();

        // Keep the webpage completely normal.
        // PII masking is applied ONLY to captured screenshots.
        removePrivacyOverlays();

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
// SCREENSHOT SANITIZATION
// ============================================================

function sanitizeScreenshot(
    screenshot,
    detectionList
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            try {

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


                            const context =
                                canvas.getContext(
                                    "2d",
                                    {
                                        willReadFrequently:
                                            true
                                    }
                                );


                            context.drawImage(
                                image,
                                0,
                                0
                            );


                            const viewportWidth =
                                window.innerWidth;

                            const viewportHeight =
                                window.innerHeight;


                            const scaleX =
                                canvas.width /
                                viewportWidth;

                            const scaleY =
                                canvas.height /
                                viewportHeight;


                            detectionList.forEach(
                                detection => {

                                    if (
                                        !detection.rect
                                    ) {
                                        return;
                                    }


                                    const rect =
                                        detection.rect;


                                    const x =
                                        Math.max(
                                            0,
                                            rect.left *
                                            scaleX
                                        );


                                    const y =
                                        Math.max(
                                            0,
                                            rect.top *
                                            scaleY
                                        );


                                    const width =
                                        Math.max(
                                            1,
                                            rect.width *
                                            scaleX
                                        );


                                    const height =
                                        Math.max(
                                            1,
                                            rect.height *
                                            scaleY
                                        );


                                    context.fillStyle =
                                        "#000000";


                                    context.fillRect(
                                        x,
                                        y,
                                        width,
                                        height
                                    );
                                }
                            );


                            resolve(
                                canvas.toDataURL(
                                    "image/png"
                                )
                            );

                        } catch (error) {

                            reject(
                                error
                            );
                        }
                    };


                image.onerror =
                    () => {

                        reject(
                            new Error(
                                "Could not load screenshot image"
                            )
                        );
                    };


                image.src =
                    screenshot;

            } catch (error) {

                reject(
                    error
                );
            }
        }
    );
}


// ============================================================
// CHECK WHETHER POINT IS INSIDE PII
// ============================================================

function isPointInsideDetection(
    x,
    y
) {

    return detections.some(
        detection => {

            const rect =
                detection.rect;

            if (!rect) {
                return false;
            }


            return (
                x >= rect.left &&
                x <= rect.right &&
                y >= rect.top &&
                y <= rect.bottom
            );
        }
    );
}


// ============================================================
// EXECUTE CLICK
// ============================================================

function executeClick(
    target
) {

    if (
        !target ||
        target.x == null ||
        target.y == null
    ) {

        return {

            success: false,

            error:
                "Click target coordinates missing"
        };
    }


    const x =
        Number(target.x);

    const y =
        Number(target.y);


    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y)
    ) {

        return {

            success: false,

            error:
                "Invalid click coordinates"
        };
    }


    if (
        isPointInsideDetection(
            x,
            y
        )
    ) {

        return {

            success: false,

            error:
                "Click blocked because target overlaps a privacy-protected region"
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

            success: false,

            error:
                "No element found at click coordinates"
        };
    }


    const clickable =
        element.closest(
            "button, input, textarea, select, a, [role='button'], [role='link']"
        ) || element;


    if (
        clickable.matches &&
        clickable.matches(
            "input[type='password']"
        )
    ) {

        return {

            success: false,

            error:
                "Click blocked on password field"
        };
    }


    clickable.click();


    console.log(
        "🖱️ Click executed"
    );


    return {

        success: true,

        action: "click",

        element:
            clickable.tagName,

        text:
            normalizeText(
                clickable.innerText ||
                clickable.textContent ||
                clickable.value ||
                ""
            ).slice(
                0,
                120
            )
    };
}


// ============================================================
// EXECUTE TYPE
// ============================================================

// ============================================================
// EXECUTE TYPE
// ============================================================
//
// Privacy model:
//
// 1. The agent receives only SAFE DOM metadata.
// 2. The value to type comes explicitly from the user's task.
// 3. The existing value of the field is NEVER sent to the server.
// 4. Screenshot PII redaction still happens locally.
// 5. Password / credential / OTP fields are ALWAYS blocked.
// 6. Normal fields such as Full Name, Email and Phone can be
//    edited locally when explicitly requested by the user.
//
// ============================================================

function executeType(
    target,
    value
) {

    // ========================================================
    // VALIDATE TARGET
    // ========================================================

    if (
        !target ||
        target.x == null ||
        target.y == null
    ) {

        return {
            success: false,
            error:
                "Type target coordinates missing"
        };
    }


    // ========================================================
    // VALIDATE VALUE
    // ========================================================

    if (
        value === null ||
        value === undefined ||
        String(value).length === 0
    ) {

        return {
            success: false,
            error:
                "Type value is empty"
        };
    }


    // ========================================================
    // FIND ELEMENT AT TARGET
    // ========================================================

    const element =
        document.elementFromPoint(
            Number(target.x),
            Number(target.y)
        );


    if (!element) {

        return {
            success: false,
            error:
                "No element found at type coordinates"
        };
    }


    // ========================================================
    // FIND EDITABLE INPUT
    // ========================================================

    const input =
        element.closest(
            "input, textarea"
        );


    if (!input) {

        return {
            success: false,
            error:
                "Target is not an input or textarea"
        };
    }


    // ========================================================
    // READ ONLY METADATA
    // ========================================================
    //
    // IMPORTANT:
    // We intentionally DO NOT read input.value.
    //
    // These attributes are safe metadata used only to
    // enforce the local privacy policy.
    //
    // ========================================================

    const inputType =
        (
            input.getAttribute(
                "type"
            ) || ""
        ).toLowerCase();


    const inputName =
        (
            input.getAttribute(
                "name"
            ) || ""
        ).toLowerCase();


    const inputId =
        (
            input.getAttribute(
                "id"
            ) || ""
        ).toLowerCase();


    const inputPlaceholder =
        (
            input.getAttribute(
                "placeholder"
            ) || ""
        ).toLowerCase();


    const autocomplete =
        (
            input.getAttribute(
                "autocomplete"
            ) || ""
        ).toLowerCase();


    const ariaLabel =
        (
            input.getAttribute(
                "aria-label"
            ) || ""
        ).toLowerCase();


    // ========================================================
    // COMBINED SAFE METADATA
    // ========================================================

    const metadata =
        [
            inputName,
            inputId,
            inputPlaceholder,
            autocomplete,
            ariaLabel
        ].join(" ");


    // ========================================================
    // HARD PRIVACY BLOCK
    // ========================================================
    //
    // These fields must NEVER be automatically typed into.
    //
    // This remains true even if the user task accidentally
    // points the agent at them.
    //
    // ========================================================

    const isPasswordField =
        inputType === "password";


    const isCredentialField =
        metadata.includes(
            "password"
        ) ||
        metadata.includes(
            "passwd"
        ) ||
        metadata.includes(
            "credential"
        ) ||
        metadata.includes(
            "secret"
        );


    const isOTPField =
        metadata.includes(
            "otp"
        ) ||
        metadata.includes(
            "one-time-code"
        ) ||
        autocomplete ===
            "one-time-code";


    if (
        isPasswordField ||
        isCredentialField ||
        isOTPField
    ) {

        console.warn(
            "🔒 Typing blocked on protected credential field"
        );

        return {
            success: false,
            error:
                "Typing into password, credential or OTP fields is blocked"
        };
    }


    // ========================================================
    // DISABLED / READONLY SAFETY
    // ========================================================

    if (
        input.disabled
    ) {

        return {
            success: false,
            error:
                "Target input is disabled"
        };
    }


    if (
        input.readOnly
    ) {

        return {
            success: false,
            error:
                "Target input is read-only"
        };
    }


    // ========================================================
    // LOCAL PII EDITING
    // ========================================================
    //
    // IMPORTANT:
    //
    // A Full Name / Email / Phone field may already contain
    // PII and therefore overlap a local privacy detection.
    //
    // That does NOT prevent the user from editing the field.
    //
    // The field's existing value remains inside the browser.
    //
    // We do NOT send input.value to the backend.
    //
    // The screenshot is still sanitized separately before
    // being sent to the AI planner.
    //
    // ========================================================

    console.log(
        "🔐 Local editable field:",
        {
            tag: input.tagName,
            type: inputType || "text",
            name: inputName,
            id: inputId,
            placeholder: inputPlaceholder
        }
    );


    // ========================================================
    // FOCUS INPUT
    // ========================================================

    input.focus();


    // ========================================================
    // SET VALUE
    // ========================================================

    input.value =
        String(value);


    // ========================================================
    // TRIGGER INPUT EVENT
    // ========================================================

    input.dispatchEvent(
        new Event(
            "input",
            {
                bubbles: true
            }
        )
    );


    // ========================================================
    // TRIGGER CHANGE EVENT
    // ========================================================

    input.dispatchEvent(
        new Event(
            "change",
            {
                bubbles: true
            }
        )
    );


    // ========================================================
    // FINAL RESULT
    // ========================================================

    console.log(
        "✅ Safe local value entered"
    );


    return {

        success: true,

        action:
            "type",

        element:
            input.tagName,

        message:
            "Safe value entered locally"
    };
}

// ============================================================
// EXECUTE SCROLL
// ============================================================

function executeScroll(
    value
) {

    let amount =
        Number(value);


    if (
        !Number.isFinite(amount)
    ) {

        amount = 500;
    }


    amount =
        Math.max(
            -1500,
            Math.min(
                1500,
                amount
            )
        );


    window.scrollBy(
        {
            top: amount,
            left: 0,
            behavior: "smooth"
        }
    );


    return {

        success: true,

        action: "scroll",

        amount
    };
}


// ============================================================
// EXECUTE WAIT
// ============================================================

function executeWait(
    value
) {

    let milliseconds =
        Number(value);


    if (
        !Number.isFinite(
            milliseconds
        )
    ) {

        milliseconds = 1000;
    }


    milliseconds =
        Math.max(
            100,
            Math.min(
                5000,
                milliseconds
            )
        );


    return {

        success: true,

        action: "wait",

        delay:
            milliseconds
    };
}


// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================

function executeBrowserAction(
    action
) {

    if (!action) {

        return {

            success: false,

            error:
                "No action received"
        };
    }


    // Backend action schema:
    // { action, x, y, text, amount, confidence, reason }
    // Legacy extension schema:
    // { type, target: { x, y }, value }
    // Accept both so the privacy engine remains compatible.

    const actionType =
        action.action ||
        action.type;

    const target =
        action.target ||
        {
            x: action.x,
            y: action.y
        };

    const value =
        action.value !== undefined
            ? action.value
            : action.text;

    if (
        actionType ===
        "click"
    ) {

        return executeClick(
            target
        );
    }


    if (
        actionType ===
        "type"
    ) {

        return executeType(
            target,
            value
        );
    }


    if (
        actionType ===
        "scroll"
    ) {

        return executeScroll(
            action.amount !== undefined
                ? action.amount
                : value
        );
    }


    if (
        actionType ===
        "wait"
    ) {

        return executeWait(
            action.amount !== undefined
                ? action.amount
                : value
        );
    }


    if (
        actionType ===
        "none"
    ) {

        return {

            success: true,

            action: "none",

            message:
                "No browser action required"
        };
    }


    return {

        success: false,

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

            runPrivacyEngine();


            const currentDetections =
                getSerializableDetections();


            const safeDOM =
                collectSafeDOM();


            removePrivacyOverlays();


            console.log(
                "📐 Capture prepared with",
                currentDetections.length,
                "PII regions"
            );


            sendResponse({

                success: true,

                detections:
                    currentDetections,

                dom_elements:
                    safeDOM,

                viewport: {

                    width:
                        window.innerWidth,

                    height:
                        window.innerHeight,

                    devicePixelRatio:
                        window.devicePixelRatio
                }
            });


            return true;
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

                message.detections || []
            )
                .then(
                    sanitizedImage => {

                        runPrivacyEngine();


                        sendResponse({

                            success: true,

                            sanitizedImage,

                            dom_elements:
                                collectSafeDOM(),

                            viewport: {

                                width:
                                    window.innerWidth,

                                height:
                                    window.innerHeight,

                                devicePixelRatio:
                                    window.devicePixelRatio
                            }
                        });
                    }
                )
                .catch(
                    error => {

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


            return true;
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
        passive: true
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

        clearTimeout(
            window.__sihPrivacyTimer
        );


        window.__sihPrivacyTimer =
            setTimeout(
                () => {

                    runPrivacyEngine();

                },
                SIH_CONFIG.inputDelay
            );
    },
    true
);


// ============================================================
// MUTATION OBSERVER
// ============================================================

const privacyObserver =
    new MutationObserver(
        mutations => {

            let relevant =
                false;


            for (
                const mutation of mutations
            ) {

                for (
                    const node
                    of mutation.addedNodes
                ) {

                    if (
                        node.nodeType !== 1
                    ) {
                        continue;
                    }


                    if (
                        node.matches &&
                        node.matches(
                            "[data-sih-privacy-overlay='true']"
                        )
                    ) {

                        continue;
                    }


                    if (
                        node.closest &&
                        node.closest(
                            "[data-sih-privacy-overlay='true']"
                        )
                    ) {

                        continue;
                    }


                    relevant =
                        true;

                    break;
                }


                if (relevant) {
                    break;
                }
            }


            if (!relevant) {
                return;
            }


            clearTimeout(
                window.__sihMutationTimer
            );


            window.__sihMutationTimer =
                setTimeout(
                    () => {

                        runPrivacyEngine();

                    },
                    SIH_CONFIG.mutationDelay
                );
        }
    );


privacyObserver.observe(
    document.documentElement,
    {
        childList: true,
        subtree: true
    }
);


// ============================================================
// INITIALIZATION
// ============================================================

function initializePrivacyAgent() {

    runPrivacyEngine();


    console.log(
        "🛡️ SIH Privacy Engine initialized"
    );
}


if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializePrivacyAgent,
        {
            once: true
        }
    );

} else {

    initializePrivacyAgent();
}

