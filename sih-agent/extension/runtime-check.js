// ============================================================
// SIH RUNTIME DEPENDENCY CHECK
// Waits for TensorFlow.js + BlazeFace before checking.
// ============================================================

(function () {

    "use strict";

    const CHECK_INTERVAL_MS = 100;
    const MAX_WAIT_MS = 10000;


    function sleep(ms) {

        return new Promise(
            function (resolve) {
                setTimeout(
                    resolve,
                    ms
                );
            }
        );
    }


    async function waitForDependencies() {

        const start =
            performance.now();

        console.log(
            "[RUNTIME CHECK] Waiting for AI dependencies..."
        );


        while (
            performance.now() - start <
            MAX_WAIT_MS
        ) {

            const tfReady =
                Boolean(
                    window.tf
                );

            const blazeReady =
                Boolean(
                    window.blazeface
                );


            if (
                tfReady &&
                blazeReady
            ) {

                return true;
            }


            await sleep(
                CHECK_INTERVAL_MS
            );
        }


        return false;
    }


    async function runRuntimeCheck() {

        const ready =
            await waitForDependencies();


        // ----------------------------------------------------
        // TensorFlow.js
        // ----------------------------------------------------

        console.log(
            "[RUNTIME CHECK] TensorFlow.js:",
            typeof window.tf
        );


        if (
            window.tf
        ) {

            console.log(
                "[RUNTIME CHECK] TensorFlow version:",
                window.tf.version?.tfjs ||
                "unknown"
            );


            try {

                await window.tf.ready();

            } catch (error) {

                console.warn(
                    "[RUNTIME CHECK] TensorFlow ready() failed:",
                    error
                );
            }


            console.log(
                "[RUNTIME CHECK] Backend:",
                window.tf.getBackend?.() ||
                "not initialized"
            );

        } else {

            console.error(
                "[RUNTIME CHECK] TensorFlow.js FAILED TO LOAD."
            );
        }


        // ----------------------------------------------------
        // BlazeFace
        // ----------------------------------------------------

        console.log(
            "[RUNTIME CHECK] BlazeFace:",
            typeof window.blazeface
        );


        if (
            window.blazeface
        ) {

            console.log(
                "[RUNTIME CHECK] BlazeFace API available."
            );

        } else {

            console.error(
                "[RUNTIME CHECK] BlazeFace FAILED TO LOAD."
            );
        }


        // ----------------------------------------------------
        // Final status
        // ----------------------------------------------------

        if (
            ready
        ) {

            console.log(
                "[RUNTIME CHECK] AI dependencies READY."
            );

        } else {

            console.error(
                "[RUNTIME CHECK] AI dependency timeout."
            );

            console.error(
                "[RUNTIME CHECK] TensorFlow:",
                Boolean(window.tf)
            );

            console.error(
                "[RUNTIME CHECK] BlazeFace:",
                Boolean(window.blazeface)
            );
        }
    }


    runRuntimeCheck();

})();