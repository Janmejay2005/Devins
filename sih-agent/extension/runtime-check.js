// ============================================================
// DEVINS RUNTIME DEPENDENCY CHECK
// Chrome + Firefox
// ============================================================

(function () {

    "use strict";


    // ========================================================
    // BROWSER DETECTION
    // ========================================================

    const USER_AGENT =
        typeof navigator !== "undefined"
            ? navigator.userAgent
            : "";


    const IS_FIREFOX =
        /Firefox\/\d+/i.test(
            USER_AGENT
        ) &&
        !/Chrome\/\d+|Chromium\/\d+|Edg\/\d+|OPR\/\d+/i.test(
            USER_AGENT
        );


    const IS_FIREFOX_CONTENT_CONTEXT =
        IS_FIREFOX &&
        typeof browser !== "undefined" &&
        browser.runtime &&
        typeof browser.runtime.sendMessage ===
            "function" &&
        typeof location !== "undefined" &&
        location.protocol !== "moz-extension:" &&
        location.protocol !== "chrome-extension:";


    // ========================================================
    // FIREFOX
    // AI runs inside sandbox.
    // ========================================================

    if (
        IS_FIREFOX_CONTENT_CONTEXT
    ) {

        console.log(
            "[RUNTIME CHECK] Browser: Firefox"
        );

        console.log(
            "[RUNTIME CHECK] Face inference: sandbox"
        );

        console.log(
            "[RUNTIME CHECK] TensorFlow.js: sandbox"
        );

        console.log(
            "[RUNTIME CHECK] BlazeFace: sandbox"
        );

        console.log(
            "[RUNTIME CHECK] AI dependencies: READY VIA SANDBOX"
        );

        return;
    }


    // ========================================================
    // CHROME / CHROMIUM
    // Wait for direct local dependencies.
    // ========================================================

    console.log(
        "[RUNTIME CHECK] Browser: Chromium"
    );


    const MAX_WAIT_MS =
        10000;

    const POLL_INTERVAL_MS =
        100;


    const started =
        performance.now();


    function checkChromeDependencies() {

        const hasTensorFlow =
            typeof window !== "undefined" &&
            typeof window.tf !== "undefined";


        const hasBlazeFace =
            typeof window !== "undefined" &&
            typeof window.blazeface !== "undefined";


        if (
            hasTensorFlow &&
            hasBlazeFace
        ) {

            console.log(
                "[RUNTIME CHECK] TensorFlow.js: object"
            );

            console.log(
                "[RUNTIME CHECK] BlazeFace: object"
            );


            console.log(
                "[RUNTIME CHECK] TensorFlow version:",
                window.tf.version?.tfjs ||
                "unknown"
            );


            let backend =
                "not initialized";


            try {

                backend =
                    window.tf.getBackend?.() ||
                    "not initialized";

            } catch (_) {}


            console.log(
                "[RUNTIME CHECK] Backend:",
                backend
            );


            console.log(
                "[RUNTIME CHECK] BlazeFace API available."
            );


            console.log(
                "[RUNTIME CHECK] AI dependencies READY."
            );


            return;
        }


        if (
            performance.now() -
            started >=
            MAX_WAIT_MS
        ) {

            console.error(
                "[RUNTIME CHECK] AI dependency timeout."
            );


            console.error(
                "[RUNTIME CHECK] TensorFlow:",
                hasTensorFlow
            );


            console.error(
                "[RUNTIME CHECK] BlazeFace:",
                hasBlazeFace
            );


            return;
        }


        setTimeout(
            checkChromeDependencies,
            POLL_INTERVAL_MS
        );
    }


    checkChromeDependencies();

})();