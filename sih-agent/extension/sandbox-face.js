// ========================================================
// DEVINS FIREFOX FACE SANDBOX
// ========================================================

(function () {

    "use strict";


    const SANDBOX_READY =
        "DEVINS_FACE_SANDBOX_READY";

    const FACE_REQUEST =
        "DEVINS_FACE_REQUEST";

    const FACE_RESULT =
        "DEVINS_FACE_RESULT";


    function sendMessage(message) {

        window.parent.postMessage(
            message,
            "*"
        );

    }


    async function runFaceDetection(
        request
    ) {

        const requestId =
            request?.requestId;


        const screenshot =
            request?.screenshot;


        if (
            typeof screenshot !== "string" ||
            !screenshot.startsWith(
                "data:image/"
            )
        ) {

            throw new Error(
                "Invalid screenshot supplied to face sandbox."
            );
        }


        if (
            typeof window.SIHFace === "undefined" ||
            typeof window.SIHFace.detect !== "function"
        ) {

            throw new Error(
                "SIHFace is unavailable inside Firefox sandbox."
            );
        }


        console.log(
            "[FACE-SANDBOX] Starting face detection."
        );


        const detections =
            await window.SIHFace.detect({

                screenshot:
                    screenshot

            });


        console.log(
            "[FACE-SANDBOX] Detection completed:",
            Array.isArray(detections)
                ? detections.length
                : 0
        );


        sendMessage({

            type:
                FACE_RESULT,

            requestId:
                requestId,

            success:
                true,

            detections:
                Array.isArray(detections)
                    ? detections
                    : []

        });

    }


    window.addEventListener(
        "message",
        async function (event) {

            if (
                event.source !==
                window.parent
            ) {
                return;
            }


            const message =
                event.data;


            if (
                !message ||
                message.type !==
                FACE_REQUEST
            ) {
                return;
            }


            try {

                await runFaceDetection(
                    message
                );

            } catch (error) {

                console.error(
                    "[FACE-SANDBOX] Detection failed:",
                    error?.message ||
                    error
                );


                sendMessage({

                    type:
                        FACE_RESULT,

                    requestId:
                        message?.requestId,

                    success:
                        false,

                    error:
                        error?.message ||
                        "Face detection failed."

                });

            }

        }
    );


    sendMessage({

        type:
            SANDBOX_READY

    });


    console.log(
        "[FACE-SANDBOX] Devins face sandbox ready."
    );

})();