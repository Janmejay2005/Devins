// ============================================================
// SIH PRIVACY BROWSER AGENT
// content.js
// ============================================================
//
// Privacy-first browser agent content script.
//
// IMPORTANT PRIVACY RULE
// ----------------------
// The webpage itself is NEVER visually masked by this script.
//
// PII masking is applied ONLY to screenshots captured by the
// extension, immediately before those screenshots are allowed
// to leave the browser.
//
// The content script:
//   1. Detects PII locally.
//   2. Provides safe DOM metadata.
//   3. Sanitizes screenshots locally.
//   4. Executes approved browser actions.
//   5. Supports scrolling + re-perception.
//
// ============================================================

console.log("SIH Privacy Agent loaded");


// ============================================================
// CONFIGURATION
// ============================================================

const SIH_CONFIG = {

    overlayColor: "#000000",

    overlayZIndex: 2147483647,

    maxDOMElements: 100,

    mutationDelay: 250,

    inputDelay: 150,

    scrollAmount: 600,

    scrollDuration: 400,

    // Browser-agent safety limits.
    maxScrollAmount: 1500,

    minWaitMs: 100,

    maxWaitMs: 5000,

    // Maximum coordinate tolerance for browser viewport.
    coordinateTolerance: 1
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


// ============================================================
// VISIBILITY
// ============================================================

function isVisible(element) {

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
// VIEWPORT CHECK
// ============================================================
//
// IMPORTANT:
//
// An element can be:
//   - visible in the document
//   - but outside the current viewport.
//
// Previously those elements were discarded from safe DOM.
//
// Now they remain available to the planner with:
//   in_viewport: true / false
//
// This allows the planner to recognize an off-screen Submit
// button and return a SCROLL action.
// ============================================================

function isInViewport(rect) {

    if (!rect) {
        return false;
    }

    return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
    );
}


// ============================================================
// DOCUMENT POSITION
// ============================================================

function getDocumentCoordinates(rect) {

    if (!rect) {
        return {
            x: 0,
            y: 0
        };
    }

    return {

        x:
            Math.round(
                rect.left +
                window.scrollX
            ),

        y:
            Math.round(
                rect.top +
                window.scrollY
            )
    };
}


// ============================================================
// NUMERIC VALUE
// ============================================================

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

    const surroundingDigits =
        getNumericValue(
            surrounding
        );

    /*
     * If the surrounding area is clearly a long
     * payment-card-like sequence, reject Aadhaar.
     */

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

        rect:
            rect
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
        ).toLowerCase() !== "password"
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
    // BODY CHECK
    // ========================================================

    if (!document.body) {
        return;
    }


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
    "[PRIVACY] Local PII detection completed:",
    detections.length,
    "regions"
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

// ============================================================
// SERIALIZABLE DETECTIONS
// ============================================================
//
// SECURITY RULE:
//
// Detection values are LOCAL-ONLY.
//
// The actual PII value is required internally for detection,
// but it must NEVER be serialized into a message sent outside
// the content script.
//
// The server only needs:
// - detection type
// - source
// - element type
// - redaction rectangle
//
// It does NOT need the detected value.
//

function getSerializableDetections() {

    return detections.map(
        detection => ({

            id:
                detection.id,

            type:
                detection.type,

            source:
                detection.source,

            tagName:
                detection.tagName,

            rect:
                detection.rect
                    ? {
                        left:
                            Number(
                                detection.rect.left
                            ),

                        top:
                            Number(
                                detection.rect.top
                            ),

                        right:
                            Number(
                                detection.rect.right
                            ),

                        bottom:
                            Number(
                                detection.rect.bottom
                            ),

                        width:
                            Number(
                                detection.rect.width
                            ),

                        height:
                            Number(
                                detection.rect.height
                            )
                    }
                    : null
        })
    );
}


// ============================================================
// SAFE DOM EXTRACTION
// ============================================================
//
// IMPORTANT CHANGE:
//
// Previously:
//   elements outside the viewport were discarded.
//
// Now:
//   off-screen elements are retained.
//
// The planner receives:
//
//   in_viewport: true
//   in_viewport: false
//
// This allows the backend to recognize that a target exists
// below the current viewport and request a scroll.
//
// We still NEVER send input.value.
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


    const collected = [];


    candidates.forEach(
        (element, index) => {

            if (
                collected.length >=
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

            const inViewport =
                isInViewport(
                    rect
                );


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


            // =================================================
            // BUTTON-LIKE IDENTIFICATION
            // =================================================

            const isButtonLike =
                tag === "button" ||
                tag === "a" ||
                role === "button" ||
                role === "link" ||
                (
                    tag === "input" &&
                    (
                        type.toLowerCase() ===
                            "submit" ||
                        type.toLowerCase() ===
                            "button" ||
                        type.toLowerCase() ===
                            "reset"
                    )
                );


            // =================================================
            // SAFE TEXT
            // =================================================

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
             * For button-like input controls only,
             * the HTML value attribute is UI metadata.
             *
             * We NEVER read input.value.
             */

            if (
                tag === "input" &&
                (
                    type.toLowerCase() ===
                        "submit" ||
                    type.toLowerCase() ===
                        "button" ||
                    type.toLowerCase() ===
                        "reset"
                )
            ) {

                text =
                    normalizeText(
                        element.getAttribute(
                            "value"
                        ) || ""
                    );
            }


            // =================================================
            // SAFE LABEL
            // =================================================

            let label =
                ariaLabel ||
                name ||
                placeholder ||
                "";


            if (
                tag === "input" &&
                (
                    type.toLowerCase() ===
                        "submit" ||
                    type.toLowerCase() ===
                        "button" ||
                    type.toLowerCase() ===
                        "reset"
                )
            ) {

                label =
                    text ||
                    label;
            }


            /*
             * Do not expose the word "password" unnecessarily
             * in ordinary metadata.
             */

            if (
                type.toLowerCase() ===
                "password"
            ) {

                label =
                    label.replace(
                        /password/gi,
                        "secure field"
                    );
            }


            // =================================================
            // DOCUMENT COORDINATES
            // =================================================

            const documentPosition =
                getDocumentCoordinates(
                    rect
                );


            // =================================================
            // COLLECT SAFE METADATA
            // =================================================

            collected.push({

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
                    ),

                in_viewport:
                    inViewport,

                document_x:
                    documentPosition.x,

                document_y:
                    documentPosition.y,

                is_button:
                    isButtonLike
            });
        }
    );


    // ========================================================
    // PRIORITIZE CURRENTLY VISIBLE ELEMENTS
    // ========================================================
    //
    // Visible controls are more immediately actionable.
    //
    // Among off-screen controls, button-like controls are
    // prioritized so things such as Submit remain available
    // to the planner even on long forms.
    // ========================================================

    collected.sort(
        (a, b) => {

            if (
                a.in_viewport !==
                b.in_viewport
            ) {

                return a.in_viewport
                    ? -1
                    : 1;
            }

            if (
                a.is_button !==
                b.is_button
            ) {

                return a.is_button
                    ? -1
                    : 1;
            }

            return (
                a.document_y -
                b.document_y
            );
        }
    );


    const limited =
        collected.slice(
            0,
            SIH_CONFIG.maxDOMElements
        );


    // Reassign stable indexes after sorting.
    limited.forEach(
        (element, index) => {

            element.index =
                index;
        }
    );


    console.log(
        "Safe DOM elements:",
        limited.length
    );

    console.log(
        "In viewport:",
        limited.filter(
            element =>
                element.in_viewport
        ).length
    );

    console.log(
        "Off-screen:",
        limited.filter(
            element =>
                !element.in_viewport
        ).length
    );


    return limited;
}


// ============================================================
// FIND ELEMENT METADATA
// ============================================================

function getElementMetadata(
    element
) {

    if (!element) {
        return null;
    }

    const rect =
        element.getBoundingClientRect();

    const tag =
        element.tagName
            ? element.tagName.toLowerCase()
            : "";

    const type =
        element.getAttribute(
            "type"
        ) || "";

    const role =
        element.getAttribute(
            "role"
        ) || "";

    const name =
        element.getAttribute(
            "name"
        ) || "";

    const id =
        element.getAttribute(
            "id"
        ) || "";

    const placeholder =
        element.getAttribute(
            "placeholder"
        ) || "";

    const ariaLabel =
        element.getAttribute(
            "aria-label"
        ) || "";

    return {

        tag,

        type,

        role,

        name,

        id,

        placeholder,

        ariaLabel,

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
            ),

        in_viewport:
            isInViewport(
                rect
            )
    };
}


// ============================================================
// PRIVACY OVERLAYS
// ============================================================
//
// These functions remain available for compatibility.
//
// IMPORTANT:
// runPrivacyEngine() DOES NOT call createPrivacyOverlays().
//
// Therefore the webpage remains completely normal.
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
        "Privacy overlays created:",
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


    privacyEngineRunning =
        true;


    try {

        detectDOMPII();

        /*
         * Keep webpage completely normal.
         *
         * PII masking is applied ONLY to captured screenshots.
         */

        removePrivacyOverlays();

    } catch (error) {

        console.error(
            "Privacy engine error:",
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
//
// Screenshot coordinates are viewport-relative.
//
// The screenshot captured by Chrome represents the current
// viewport, therefore getBoundingClientRect() coordinates map
// directly after scaling.
//
// Only detections belonging to the captured viewport are useful.
// Off-screen detections are naturally clipped by the canvas.
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

                if (
                    !screenshot
                ) {

                    reject(
                        new Error(
                            "Screenshot data is missing"
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


                            const context =
                                canvas.getContext(
                                    "2d",
                                    {
                                        willReadFrequently:
                                            true
                                    }
                                );


                            if (!context) {

                                reject(
                                    new Error(
                                        "Could not create canvas context"
                                    )
                                );

                                return;
                            }


                            context.drawImage(
                                image,
                                0,
                                0
                            );


                            const viewportWidth =
                                window.innerWidth;

                            const viewportHeight =
                                window.innerHeight;


                            if (
                                viewportWidth <= 0 ||
                                viewportHeight <= 0
                            ) {

                                reject(
                                    new Error(
                                        "Invalid viewport dimensions"
                                    )
                                );

                                return;
                            }


                            const scaleX =
                                canvas.width /
                                viewportWidth;

                            const scaleY =
                                canvas.height /
                                viewportHeight;


                            detectionList.forEach(
                                detection => {

                                    if (
                                        !detection ||
                                        !detection.rect
                                    ) {
                                        return;
                                    }


                                    const rect =
                                        detection.rect;


                                    /*
                                     * Ignore detections that are
                                     * completely outside the current
                                     * viewport.
                                     */

                                    if (
                                        rect.right <= 0 ||
                                        rect.bottom <= 0 ||
                                        rect.left >= viewportWidth ||
                                        rect.top >= viewportHeight
                                    ) {
                                        return;
                                    }


                                    const clippedLeft =
                                        Math.max(
                                            0,
                                            rect.left
                                        );

                                    const clippedTop =
                                        Math.max(
                                            0,
                                            rect.top
                                        );

                                    const clippedRight =
                                        Math.min(
                                            viewportWidth,
                                            rect.right
                                        );

                                    const clippedBottom =
                                        Math.min(
                                            viewportHeight,
                                            rect.bottom
                                        );


                                    const x =
                                        Math.max(
                                            0,
                                            clippedLeft *
                                            scaleX
                                        );

                                    const y =
                                        Math.max(
                                            0,
                                            clippedTop *
                                            scaleY
                                        );

                                    const width =
                                        Math.max(
                                            1,
                                            (
                                                clippedRight -
                                                clippedLeft
                                            ) *
                                            scaleX
                                        );

                                    const height =
                                        Math.max(
                                            1,
                                            (
                                                clippedBottom -
                                                clippedTop
                                            ) *
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
// CHECK WHETHER POINT IS IN VIEWPORT
// ============================================================

function isPointInViewport(
    x,
    y
) {

    return (
        Number.isFinite(
            Number(x)
        ) &&
        Number.isFinite(
            Number(y)
        ) &&
        Number(x) >= 0 &&
        Number(y) >= 0 &&
        Number(x) <= window.innerWidth &&
        Number(y) <= window.innerHeight
    );
}

// ============================================================
// BROWSER AGENT SAFETY GATE
// ============================================================
//
// Every browser action must pass local validation before it
// reaches the actual DOM executor.
//
// The planner is NOT trusted to directly control the browser.
//
// Safety checks performed here include:
// - supported action type
// - valid coordinates
// - viewport bounds
// - visible target
// - interactable target
// - disabled / readonly protection
// - password / OTP / credential protection
// - submit-target validation
// - bounded scroll
// - bounded wait
//
// IMPORTANT:
// These checks happen locally inside the browser.
// No sensitive field value is read.
// ============================================================

const ALLOWED_BROWSER_ACTIONS = new Set([
    "click",
    "type",
    "scroll",
    "wait",
    "none"
]);


const SENSITIVE_TARGET_PATTERN =
    /\b(?:password|passwd|passcode|credential|credentials|secret|otp|one[-\s]?time[-\s]?password|one[-\s]?time[-\s]?code|security[-\s]?code|verification[-\s]?code|auth[-\s]?code|pin)\b/i;


// ============================================================
// SAFE METADATA EXTRACTION
// ============================================================

function getElementSafetyMetadata(element) {

    if (!element) {
        return {
            tag: "",
            type: "",
            role: "",
            name: "",
            id: "",
            placeholder: "",
            ariaLabel: "",
            autocomplete: ""
        };
    }


    return {

        tag:
            String(
                element.tagName || ""
            ).toLowerCase(),

        type:
            String(
                element.getAttribute("type") || ""
            ).toLowerCase(),

        role:
            String(
                element.getAttribute("role") || ""
            ).toLowerCase(),

        name:
            String(
                element.getAttribute("name") || ""
            ).toLowerCase(),

        id:
            String(
                element.getAttribute("id") || ""
            ).toLowerCase(),

        placeholder:
            String(
                element.getAttribute("placeholder") || ""
            ).toLowerCase(),

        ariaLabel:
            String(
                element.getAttribute("aria-label") || ""
            ).toLowerCase(),

        autocomplete:
            String(
                element.getAttribute("autocomplete") || ""
            ).toLowerCase()
    };
}


// ============================================================
// SENSITIVE TARGET CHECK
// ============================================================
//
// This function NEVER reads element.value.
//
// Only HTML metadata is inspected.
// ============================================================

function isSensitiveTarget(element) {

    if (!element) {
        return true;
    }


    const metadata =
        getElementSafetyMetadata(
            element
        );

     if (
        metadata.tag === "button" ||
        (
            metadata.tag === "input" &&
            metadata.type === "submit"
        ) ||
        metadata.role === "button"
    ) {
        return false;
    }
    // Native password field.
    if (
        metadata.type === "password"
    ) {
        return true;
    }


    // Sensitive autocomplete tokens.
    if (
        metadata.autocomplete === "one-time-code" ||
        metadata.autocomplete === "cc-csc" ||
        metadata.autocomplete === "cc-cvc"
    ) {
        return true;
    }


    const combined =
        [
            metadata.type,
            metadata.name,
            metadata.id,
            metadata.placeholder,
            metadata.ariaLabel,
            metadata.autocomplete
        ]
            .join(" ")
            .trim();


    return SENSITIVE_TARGET_PATTERN.test(
        combined
    );
}


// ============================================================
// VISIBLE TARGET CHECK
// ============================================================

function isInteractableElement(element) {

    if (!element) {
        return false;
    }


    if (!isVisible(element)) {
        return false;
    }


    if (
        element.disabled === true
    ) {
        return false;
    }


    if (
        element.hasAttribute &&
        element.hasAttribute("aria-disabled") &&
        String(
            element.getAttribute(
                "aria-disabled"
            )
        ).toLowerCase() === "true"
    ) {
        return false;
    }


    const style =
        window.getComputedStyle(
            element
        );


    if (
        style.pointerEvents === "none"
    ) {
        return false;
    }


    return true;
}


// ============================================================
// CLICKABLE TARGET CHECK
// ============================================================

function isClickableElement(element) {

    if (!element) {
        return false;
    }

    const tag =
        String(
            element.tagName || ""
        ).toLowerCase();

    const type =
        String(
            element.getAttribute?.("type") || ""
        ).toLowerCase();

    const role =
        String(
            element.getAttribute?.("role") || ""
        ).toLowerCase();

    // Standard clickable HTML controls.
    if (
        tag === "button" ||
        tag === "a" ||
        tag === "select"
    ) {
        return true;
    }

    // Textarea is not a click action target for the agent.
    if (
        tag === "textarea"
    ) {
        return false;
    }

    // Only explicitly clickable input types.
    if (
        tag === "input"
    ) {

        return (
            type === "button" ||
            type === "submit" ||
            type === "reset" ||
            type === "checkbox" ||
            type === "radio" ||
            type === "file" ||
            type === "image"
        );
    }

    // ARIA controls.
    if (
        role === "button" ||
        role === "link" ||
        role === "menuitem" ||
        role === "tab"
    ) {
        return true;
    }

    // Elements with an explicit click handler.
    if (
        typeof element.onclick === "function"
    ) {
        return true;
    }

    return false;
}


// ============================================================
// SUBMIT TARGET CHECK
// ============================================================
//
// Used when the agent is explicitly performing a submit flow.
//
// We inspect metadata and visible UI text only.
// We NEVER inspect input.value.
// ============================================================

// ============================================================
// SUBMIT TARGET CHECK
// ============================================================
//
// Used when the agent is explicitly performing a submit flow.
//
// We inspect only safe UI metadata / visible button text.
// We NEVER inspect input.value.
// ============================================================

function isSubmitElement(element) {

    if (!element) {
        return false;
    }

    const tag =
        String(
            element.tagName || ""
        ).toLowerCase();

    const type =
        String(
            element.getAttribute?.("type") || ""
        ).toLowerCase();

    const role =
        String(
            element.getAttribute?.("role") || ""
        ).toLowerCase();

    const text =
        normalizeText(
            element.innerText ||
            element.textContent ||
            element.getAttribute?.("aria-label") ||
            ""
        ).toLowerCase();

    // --------------------------------------------------------
    // Native input submit
    // --------------------------------------------------------

    if (
        tag === "input" &&
        type === "submit"
    ) {
        return true;
    }

    // --------------------------------------------------------
    // Button elements
    //
    // Accept:
    //   <button>
    //   <button type="submit">
    //   <button type="button">
    //
    // BUT ONLY when the visible label explicitly indicates
    // a submit/continue/apply/finish/confirm action.
    // --------------------------------------------------------

    if (tag === "button") {

        const hasSubmitLabel =
            /\bsubmit\b|\bapply\b|\bcontinue\b|\bfinish\b|\bconfirm\b/.test(
                text
            );

        if (
            hasSubmitLabel &&
            (
                type === "" ||
                type === "submit" ||
                type === "button"
            )
        ) {
            return true;
        }
    }

    // --------------------------------------------------------
    // ARIA buttons
    // --------------------------------------------------------

    if (
        role === "button"
    ) {

        const hasSubmitLabel =
            /\bsubmit\b|\bapply\b|\bcontinue\b|\bfinish\b|\bconfirm\b/.test(
                text
            );

        if (hasSubmitLabel) {
            return true;
        }
    }

    return false;
}

// ============================================================
// ACTION TYPE VALIDATION
// ============================================================

function validateActionType(
    actionType
) {

    const normalized =
        String(
            actionType || ""
        )
            .toLowerCase()
            .trim();


    if (
        !ALLOWED_BROWSER_ACTIONS.has(
            normalized
        )
    ) {

        return {

            valid: false,

            error:
                `Unsupported browser action: ${
                    normalized || "missing"
                }`
        };
    }


    return {

        valid: true,

        action:
            normalized
    };
}


// ============================================================
// COORDINATE VALIDATION
// ============================================================

function validateActionCoordinates(
    target
) {

    if (
        !target ||
        target.x === undefined ||
        target.y === undefined
    ) {

        return {

            valid: false,

            error:
                "Action target coordinates are missing"
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

            valid: false,

            error:
                "Action target coordinates are invalid"
        };
    }


    if (
        !isPointInViewport(
            x,
            y
        )
    ) {

        return {

            valid: false,

            requiresScroll: true,

            error:
                "Action target is outside the current viewport",

            x,
            y
        };
    }


    return {

        valid: true,

        x,
        y
    };
}


// ============================================================
// CLICK TARGET VALIDATION
// ============================================================

function validateClickTarget(action) {
    if (!action || typeof action !== "object") {
        return {
            valid: false,
            reason: "Invalid action object."
        };
    }

    if (action.type !== "click") {
        return {
            valid: false,
            reason: "Action is not a click."
        };
    }

    const x = Number(action.x);
    const y = Number(action.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {
            valid: false,
            reason: "Click coordinates are invalid."
        };
    }

    if (x < 0 || y < 0) {
        return {
            valid: false,
            reason: "Click coordinates cannot be negative."
        };
    }

    const target = document.elementFromPoint(x, y);

    if (!target) {
        return {
    valid: false,
    retryable: true,
    reason:
        "No DOM element exists at the requested coordinates."
};
    }

    const clickable = target.closest(
        'button, a, input, select, textarea, [role="button"], [role="link"], [onclick]'
    );

    if (!clickable) {
        return {
    valid: false,
    retryable: true,
    reason:
        "Target is not a clickable element."
};
    }

    /*
     * HARD PRIVACY / SAFETY BLOCK
     *
     * Never allow the agent to click password,
     * OTP, credential, PIN, or security-code fields.
     */
    if (isSensitiveTarget(clickable)) {
        return {
            valid: false,
            reason: "Click blocked because target is a sensitive security field."
        };
    }

    /*
     * SUBMIT SAFETY GATE
     *
     * The planner may provide submitIntent=true when
     * the current task explicitly requires submitting.
     *
     * If submitIntent is true, ONLY an actual submit
     * control is allowed.
     */
    if (action.submitIntent === true) {
        if (!isSubmitElement(clickable)) {
            return {
    valid: false,
    retryable: true,
    reason:
        "Submit action blocked because target is not a submit control."
};
        }
    }

    /*
     * Optional target metadata validation.
     *
     * This prevents a planner from selecting a sensitive
     * field even when coordinates happen to point there.
     */
    const metadata = {
        tagName: String(clickable.tagName || "").toLowerCase(),
        type: String(clickable.getAttribute?.("type") || "").toLowerCase(),
        name: String(clickable.getAttribute?.("name") || "").toLowerCase(),
        id: String(clickable.id || "").toLowerCase(),
        ariaLabel: String(
            clickable.getAttribute?.("aria-label") || ""
        ).toLowerCase()
    };

    const sensitivePattern =
        /\b(password|passwd|passcode|credential|credentials|otp|one[-\s]?time[-\s]?password|security[-\s]?code|pin|secret)\b/i;

    const metadataText = [
        metadata.tagName,
        metadata.type,
        metadata.name,
        metadata.id,
        metadata.ariaLabel
    ].join(" ");

    if (sensitivePattern.test(metadataText)) {
        return {
            valid: false,
            reason: "Click blocked because target metadata indicates a sensitive field."
        };
    }

    return {
        valid: true,
        element: clickable,
        x,
        y
    };
}


// ============================================================
// TYPE TARGET VALIDATION
// ============================================================

function validateTypeTarget(
    target,
    value
) {

    if (
        value === null ||
        value === undefined ||
        String(value).length === 0
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing requires an explicit non-empty value"
        };
    }


    const coordinates =
        validateActionCoordinates(
            target
        );


    if (
        !coordinates.valid
    ) {
        return coordinates;
    }


    const element =
        document.elementFromPoint(
            coordinates.x,
            coordinates.y
        );


    if (!element) {

        return {

            valid: false,

            retryable: true,

            error:
                "No DOM element exists at the requested typing coordinates"
        };
    }


    const input =
        element.closest?.(
            "input, textarea"
        );


    if (!input) {

        return {

            valid: false,

            retryable: true,

            error:
                "Typing target is not an input or textarea"
        };
    }


    if (
        !isInteractableElement(
            input
        )
    ) {

        return {

            valid: false,

            retryable: true,

            error:
                "Typing target is not visible or interactable"
        };
    }


    if (
        isSensitiveTarget(
            input
        )
    ) {

        return {
    valid: false,
    unsafe: true,
    error:
        "Typing blocked on password, OTP, credential or security field"
};
    }


    if (
        input.readOnly === true
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing blocked on read-only field"
        };
    }


    if (
        input.disabled === true
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Typing blocked on disabled field"
        };
    }


    return {

        valid: true,

        element:
            input
    };
}


// ============================================================
// SCROLL VALIDATION
// ============================================================

function validateScrollAmount(
    value
) {

    const amount =
        Number(value);


    if (
        !Number.isFinite(
            amount
        )
    ) {

        return {

            valid: false,

            error:
                "Scroll amount is invalid"
        };
    }


    if (
        amount === 0
    ) {

        return {

            valid: false,

            error:
                "Scroll amount cannot be zero"
        };
    }


    const boundedAmount =
        Math.max(
            -SIH_CONFIG.maxScrollAmount,
            Math.min(
                SIH_CONFIG.maxScrollAmount,
                amount
            )
        );


    return {

        valid: true,

        amount:
            boundedAmount
    };
}


// ============================================================
// WAIT VALIDATION
// ============================================================

function validateWaitDuration(
    value
) {

    const milliseconds =
        Number(value);


    if (
        !Number.isFinite(
            milliseconds
        )
    ) {

        return {

            valid: false,

            error:
                "Wait duration is invalid"
        };
    }


    const boundedDuration =
        Math.max(
            SIH_CONFIG.minWaitMs,
            Math.min(
                SIH_CONFIG.maxWaitMs,
                milliseconds
            )
        );


    return {

        valid: true,

        milliseconds:
            boundedDuration
    };
}


// ============================================================
// COMPLETE ACTION SAFETY VALIDATOR
// ============================================================
//
// This is the single local gate for browser actions.
//
// ============================================================

function validateBrowserAction(
    action
) {

    if (
        !action ||
        typeof action !== "object"
    ) {

        return {

            valid: false,

            unsafe: true,

            error:
                "Browser action is missing or malformed"
        };
    }


    const actionType =
        String(
            action.action ||
            action.type ||
            ""
        )
            .toLowerCase()
            .trim();


    const typeValidation =
        validateActionType(
            actionType
        );


    if (
        !typeValidation.valid
    ) {

        return typeValidation;
    }


    // --------------------------------------------------------
    // NONE
    // --------------------------------------------------------

    if (
        actionType === "none"
    ) {

        return {

            valid: true,

            action:
                "none"
        };
    }


        // --------------------------------------------------------
    // CLICK
    // --------------------------------------------------------

    if (
    actionType === "click"
) {

    const submitIntent =
        action?.submitIntent === true ||
        action?.target?.submitIntent === true;

    // --------------------------------------------------------
    // SUBMIT INTENT
    // --------------------------------------------------------
    //
    // For Submit actions, the AI coordinates are NOT trusted
    // as the actual click target.
    //
    // executeClick() will resolve the real Submit control
    // locally using DOM semantics and safety checks.
    //
    // Therefore we must NOT run validateClickTarget()
    // against the AI coordinates here.
    // --------------------------------------------------------

    if (submitIntent) {

        return {
            valid: true,
            action: "click",
            submitIntent: true
        };
    }

    // --------------------------------------------------------
    // NORMAL CLICK
    // --------------------------------------------------------

    const target = {
        x:
            action?.target?.x !== undefined
                ? action.target.x
                : action?.x,

        y:
            action?.target?.y !== undefined
                ? action.target.y
                : action?.y,

        submitIntent: false
    };

    return {
        action: "click",

        ...validateClickTarget(
            target
        )
    };

    }
    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    if (
        actionType === "type"
    ) {

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


        return {
            action: "type",
            ...validateTypeTarget(
                target,
                value
            )
        };
    }


    // --------------------------------------------------------
    // SCROLL
    // --------------------------------------------------------

    if (
        actionType === "scroll"
    ) {

        const amount =
            action.amount !== undefined
                ? action.amount
                : action.value;


        return {
            action: "scroll",
            ...validateScrollAmount(
                amount
            )
        };
    }


    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    if (
        actionType === "wait"
    ) {

        const duration =
            action.amount !== undefined
                ? action.amount
                : action.value;


        return {
            action: "wait",
            ...validateWaitDuration(
                duration
            )
        };
    }


    return {

        valid: false,

        unsafe: true,

        error:
            "Browser action failed safety validation"
    };
}
// ============================================================
// SCROLL TO ELEMENT
// ============================================================
//
// This helper is intentionally local.
//
// It can be used when the extension has an actual DOM target.
//
// The current planner architecture normally returns a scroll
// action first, after which popup.js captures and sanitizes the
// new viewport again.
//
// ============================================================

function scrollElementIntoView(
    element
) {

    if (!element) {

        return {
            success: false,
            error:
                "Element not found"
        };
    }


    try {

        element.scrollIntoView(
            {
                behavior: "smooth",
                block: "center",
                inline: "center"
            }
        );


        return {
            success: true,
            action: "scroll",
            message:
                "Element scrolled into view"
        };

    } catch (error) {

        return {
            success: false,
            error:
                error.message
        };
    }
}




// ============================================================
// EXECUTE CLICK
// ============================================================

function executeClick(action) {
    console.log("[ACTION] Click request received.");

    const submitIntent =
        action?.submitIntent === true ||
        action?.target?.submitIntent === true;

    // =========================================================
    // SUBMIT INTENT
    // =========================================================
    //
    // For Submit, do not blindly trust an AI-generated
    // coordinate. Resolve the actual Submit control locally.
    //
    // This keeps the final click decision inside the browser.
    // =========================================================

    if (submitIntent) {
        console.log(
            "[SAFETY] Submit intent detected. Resolving Submit button locally."
        );

        const submitCandidates = Array.from(
    document.querySelectorAll(
        [
            'button',
            'input[type="submit"]',
            '[role="button"]'
        ].join(",")
    )
);

        let submitButton = null;

        for (const candidate of submitCandidates) {
            try {
                if (!candidate) {
                    continue;
                }

                if (!isSubmitElement(candidate)) {
                    continue;
                }
                console.log(
    "[SAFETY] Submit candidate identified:",
    candidate.tagName
);
                if (!isInteractableElement(candidate)) {
                    continue;
                }

                if (isSensitiveTarget(candidate)) {
                    console.warn(
                        "[SAFETY] Submit candidate rejected as sensitive."
                    );
                    continue;
                }

                submitButton = candidate;
                break;
            } catch (error) {
                console.warn(
                    "[SAFETY] Submit candidate check failed."
                );
            }
        }

        if (!submitButton) {
            console.warn(
                "[SAFETY] No safe Submit control found."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: no safe Submit control found."
            };
        }

        // Make sure the real Submit control is visible.
        try {
            submitButton.scrollIntoView({
                behavior: "auto",
                block: "center",
                inline: "center"
            });
        } catch (_) {
            // Ignore scroll failure; final interactability
            // check below still applies.
        }

        // Re-check after scrolling.
        if (!isInteractableElement(submitButton)) {
            console.warn(
                "[SAFETY] Submit control is not interactable."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: Submit control is not interactable."
            };
        }

        if (isSensitiveTarget(submitButton)) {
            console.warn(
                "[SAFETY] Submit control failed final sensitivity check."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Browser action rejected by local safety policy: Submit control failed final safety validation."
            };
        }

        console.log(
            "[SAFETY] Safe Submit control resolved locally."
        );

        try {
            submitButton.click();

            console.log(
                "[ACTION] Submit click executed successfully."
            );

            return {
                success: true,
                action: "click",
                element: submitButton.tagName
            };
        } catch (error) {
            console.error(
                "[ACTION] Submit click failed."
            );

            return {
                success: false,
                action: "click",
                error:
                    "Submit click execution failed."
            };
        }
    }

    // =========================================================
    // NORMAL CLICK
    // =========================================================

    const validation = validateBrowserAction(action);

    if (!validation.valid) {
        console.warn(
            "[SAFETY] Click rejected by local validation."
        );

        return {
            success: false,
            action: "click",
            error:
                validation.error ||
                "Browser action rejected by local safety policy."
        };
    }

    const clickable =
        validation.element;

    if (!clickable) {
        return {
            success: false,
            action: "click",
            error:
                "No safe clickable element found."
        };
    }

    // Final local safety check.
    if (!isInteractableElement(clickable)) {
        return {
            success: false,
            action: "click",
            error:
                "Browser action rejected: target is not interactable."
        };
    }

    if (isSensitiveTarget(clickable)) {
        return {
            success: false,
            action: "click",
            error:
                "Browser action rejected: target is sensitive."
        };
    }

    try {
        clickable.click();

        return {
            success: true,
            action: "click",
            element: clickable.tagName
        };
    } catch (error) {
        return {
            success: false,
            action: "click",
            error:
                "Click execution failed."
        };
    }
}
// ============================================================
// EXECUTE TYPE
// ============================================================
//
// Privacy model:
//
// 1. Agent receives only SAFE DOM metadata.
// 2. Value to type comes explicitly from user's task.
// 3. Existing value is NEVER sent to server.
// 4. Screenshot PII redaction happens locally.
// 5. Password / credential / OTP fields are blocked.
// 6. Normal requested fields can be edited locally.
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
    // VALIDATE VIEWPORT
    // ========================================================

    const x =
        Number(target.x);

    const y =
        Number(target.y);


    if (
        !isPointInViewport(
            x,
            y
        )
    ) {

        return {

            success: false,

            action:
                "scroll_required",

            error:
                "Type target is outside the current viewport",

            x,

            y
        };
    }


    // ========================================================
    // FIND ELEMENT AT TARGET
    // ========================================================

    const element =
        document.elementFromPoint(
            x,
            y
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
    //
    // We intentionally DO NOT read input.value.
    //
    // These attributes are safe metadata used only to enforce
    // the local privacy policy.
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
    metadata.includes(
        "one time code"
    ) ||
    metadata.includes(
        "one-time-password"
    ) ||
    metadata.includes(
        "verification code"
    ) ||
    autocomplete ===
        "one-time-code";


    if (
        isPasswordField ||
        isCredentialField ||
        isOTPField
    ) {

        console.warn(
            "Typing blocked on protected credential field"
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
    // A Full Name / Email / Phone field may contain PII.
    //
    // That does NOT prevent the user from editing it.
    //
    // Existing field value remains inside the browser.
    //
    // We never send input.value to backend.
    // ========================================================

    console.log(
        "🔐 Local editable field:",
        {
            tag:
                input.tagName,

            type:
                inputType ||
                "text",

            name:
                inputName,

            id:
                inputId,

            placeholder:
                inputPlaceholder
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
        "Safe local value entered"
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
//
// The planner can return:
//
// {
//     action: "scroll",
//     amount: 600
// }
//
// After this action succeeds, popup.js performs another
// capture + local sanitization + AI planning cycle.
//
// ============================================================

// ============================================================
// EXECUTE SCROLL
// ============================================================

function executeScroll(
    value
) {

    const validation =
        validateScrollAmount(
            value
        );


    if (
        !validation.valid
    ) {

        return {

            success: false,

            action:
                "scroll_blocked",

            error:
                validation.error
        };
    }


    const amount =
        validation.amount;


    try {

        window.scrollBy({

            top:
                amount,

            left:
                0,

            behavior:
                "smooth"
        });

    } catch (error) {

        return {

            success: false,

            action:
                "scroll",

            retryable: true,

            error:
                "Scroll execution failed"
        };
    }


    return {

        success: true,

        action:
            "scroll",

        amount
    };
}


// ============================================================
// EXECUTE WAIT
// ============================================================

function executeWait(
    value
) {

    const validation =
        validateWaitDuration(
            value
        );


    if (
        !validation.valid
    ) {

        return {

            success: false,

            action:
                "wait_blocked",

            error:
                validation.error
        };
    }


    return {

        success: true,

        action:
            "wait",

        delay:
            validation.milliseconds
    };
}

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================

// ============================================================
// EXECUTE BROWSER ACTION
// ============================================================
//
// The planner is untrusted.
//
// Every action passes through:
//     1. Local safety validation
//     2. Action-specific executor
//     3. Executor-level validation
//
// Fail closed on anything unexpected.
// ============================================================

function executeBrowserAction(
    action
) {

    // --------------------------------------------------------
    // GLOBAL ACTION SAFETY GATE
    // --------------------------------------------------------

    const validation =
        validateBrowserAction(
            action
        );

    if (
        !validation.valid
    ) {

        console.warn(
            "[SAFETY] Browser action blocked:",
            validation.error
        );

        if (
            validation.requiresScroll
        ) {

            return {
                success: false,

                action:
                    "scroll_required",

                error:
                    validation.error,

                x:
                    validation.x,

                y:
                    validation.y,

                retryable:
                    true
            };
        }

        return {
    success: false,

    action:
        validation.action ||
        "action_blocked",

    retryable:
        validation.retryable === true,

    unsafe:
        validation.unsafe === true,

    error:
        validation.error ||
        "Browser action rejected by local safety policy"
};
    }


    // --------------------------------------------------------
    // NORMALIZED ACTION TYPE
    // --------------------------------------------------------

    const actionType =
        validation.action;


    // --------------------------------------------------------
    // NONE
    // --------------------------------------------------------

    if (
        actionType === "none"
    ) {

        return {
            success: true,

            action:
                "none"
        };
    }


    // --------------------------------------------------------
    // CLICK
    // --------------------------------------------------------

    if (
        actionType === "click"
    ) {

        const target = {
    x:
        action?.target?.x !== undefined
            ? action.target.x
            : action?.x,

    y:
        action?.target?.y !== undefined
            ? action.target.y
            : action?.y,

    submitIntent:
        action?.submitIntent === true ||
        action?.target?.submitIntent === true
};

return executeClick(
    target
);
    }


    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    if (
        actionType === "type"
    ) {

        const target =
            action?.target ||
            {
                x:
                    action?.x,

                y:
                    action?.y
            };

        const value =
            action?.value !== undefined
                ? action.value
                : action?.text;

        return executeType(
            target,
            value
        );
    }


    // --------------------------------------------------------
    // SCROLL
    // --------------------------------------------------------

    if (
        actionType === "scroll"
    ) {

        const amount =
            action?.amount !== undefined
                ? action.amount
                : action?.value;

        return executeScroll(
            amount
        );
    }


    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    if (
        actionType === "wait"
    ) {

        const duration =
            action?.amount !== undefined
                ? action.amount
                : action?.value;

        return executeWait(
            duration
        );
    }


    // --------------------------------------------------------
    // FAIL CLOSED
    // --------------------------------------------------------

    return {
        success: false,

        action:
            "action_blocked",

        unsafe: true,

        error:
            "Browser action failed closed"
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


            /*
             * Never leave visible privacy overlays on the page.
             */

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
                        window.devicePixelRatio,

                    scrollX:
                        window.scrollX,

                    scrollY:
                        window.scrollY,

                    documentWidth:
                        document.documentElement
                            ? document.documentElement.scrollWidth
                            : window.innerWidth,

                    documentHeight:
                        document.documentElement
                            ? document.documentElement.scrollHeight
                            : window.innerHeight
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

            captureInProgress =
                true;


            sanitizeScreenshot(

                message.screenshot,

                message.detections || []
            )
                .then(
                    sanitizedImage => {

                        runPrivacyEngine();


                        captureInProgress =
                            false;


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
                                    window.devicePixelRatio,

                                scrollX:
                                    window.scrollX,

                                scrollY:
                                    window.scrollY,

                                documentWidth:
                                    document.documentElement
                                        ? document.documentElement.scrollWidth
                                        : window.innerWidth,

                                documentHeight:
                                    document.documentElement
                                        ? document.documentElement.scrollHeight
                                        : window.innerHeight
                            }
                        });
                    }
                )
                .catch(
                    error => {

                        captureInProgress =
                            false;


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
    "[ACTION] Execution completed:",
    {
        success:
            result?.success === true,

        action:
            result?.action ||
            "unknown"
    }
);


            sendResponse(
                result
            );


            return true;
        }


        // ====================================================
        // SCROLL TO TARGET
        // ====================================================
        //
        // Optional direct DOM-target scrolling.
        //
        // The planner normally uses a regular scroll action,
        // but this message provides a safe local helper for
        // future target-aware scrolling.
        //
        // It accepts:
        //
        // {
        //     selector: "...",
        //     targetText: "Submit"
        // }
        //
        // No input values are read.
        // ====================================================

        if (
            message.type ===
            "SCROLL_TO_TARGET"
        ) {

            let targetElement =
                null;


            if (
                message.selector
            ) {

                try {

                    targetElement =
                        document.querySelector(
                            message.selector
                        );

                } catch (_) {

                    targetElement =
                        null;
                }
            }


            if (
                !targetElement &&
                message.targetText
            ) {

                const requestedText =
                    normalizeText(
                        message.targetText
                    ).toLowerCase();


                const possibleElements =
                    document.querySelectorAll(
                        "button, a, input, textarea, [role='button'], [role='link']"
                    );


                for (
                    const element
                    of possibleElements
                ) {

                    if (
                        !isVisible(element)
                    ) {
                        continue;
                    }


                    const tag =
                        element.tagName
                            .toLowerCase();


                    const type =
                        (
                            element.getAttribute(
                                "type"
                            ) || ""
                        ).toLowerCase();


                    let text =
                        normalizeText(
                            element.innerText ||
                            element.textContent ||
                            ""
                        );


                    if (
                        tag === "input" &&
                        (
                            type === "submit" ||
                            type === "button" ||
                            type === "reset"
                        )
                    ) {

                        text =
                            normalizeText(
                                element.getAttribute(
                                    "value"
                                ) || ""
                            );
                    }


                    if (
                        text
                            .toLowerCase()
                            .includes(
                                requestedText
                            )
                    ) {

                        targetElement =
                            element;

                        break;
                    }
                }
            }


            if (!targetElement) {

                sendResponse({

                    success: false,

                    error:
                        "Target element not found"
                });

                return true;
            }


            const result =
                scrollElementIntoView(
                    targetElement
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
//
// Re-run local PII detection after user edits a field.
//
// Existing values remain local.
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
// CHANGE EVENT
// ============================================================

document.addEventListener(
    "change",
    () => {

        clearTimeout(
            window.__sihPrivacyChangeTimer
        );


        window.__sihPrivacyChangeTimer =
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
                const mutation
                of mutations
            ) {

                for (
                    const node
                    of mutation.addedNodes
                ) {

                    if (
                        node.nodeType !==
                        1
                    ) {
                        continue;
                    }


                    /*
                     * Ignore our own privacy overlays.
                     */

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


                if (
                    relevant
                ) {
                    break;
                }
            }


            if (
                !relevant
            ) {
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
        childList:
            true,

        subtree:
            true
    }
);


// ============================================================
// INITIALIZATION
// ============================================================

function initializePrivacyAgent() {

    runPrivacyEngine();

    removePrivacyOverlays();


    console.log(
        "SIH Privacy Engine initialized"
    );

    console.log(
        "Screenshot-only PII masking active"
    );

    console.log(
        "Off-screen DOM perception enabled"
    );
}


// ============================================================
// DOM READY
// ============================================================

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializePrivacyAgent,
        {
            once:
                true
        }
    );

} else {

    initializePrivacyAgent();
}