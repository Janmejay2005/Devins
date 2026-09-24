// ============================================================
// SIH PRIVACY BROWSER AGENT
// ocr.js
// ============================================================
//
// Phase 2.2 — Local Screenshot OCR
//
// Pipeline:
//
//   Screenshot
//       ↓
//   Tesseract.js
//       ↓
//   OCR text
//       ↓
//   Word-level bounding boxes
//
// IMPORTANT:
//
// - OCR runs locally inside the browser.
// - Raw OCR text never leaves this content script.
// - OCR results are NOT yet classified as PII.
// - OCR results are NOT yet added to the redaction engine.
//
// Those features belong to Phase 2.3+.
//
// ============================================================

(function () {

    "use strict";


    // ========================================================
    // VERSION / STATE
    // ========================================================

    const OCR_VERSION = "2.2.0";

    let worker = null;

    let initializing = null;


    // ========================================================
    // BENCHMARK STATE
    // ========================================================

    const ocrMetrics = {

        runs: 0,

        totalLatencyMs: 0,

        lastLatencyMs: 0,

        lastWordCount: 0,

        totalWords: 0

    };


    // ========================================================
    // INITIALIZE TESSERACT
    // ========================================================

    async function initializeOCR() {

        if (worker) {

            return worker;

        }


        if (initializing) {

            return initializing;

        }


        if (
            typeof window.Tesseract ===
            "undefined"
        ) {

            throw new Error(
                "Tesseract.js is not loaded."
            );

        }


        initializing =
            (async function () {

                console.log(
                    "[OCR] Initializing Tesseract.js..."
                );


                /*
                 * Tesseract.js v7
                 *
                 * Worker is created locally.
                 *
                 * Language:
                 *   English
                 */

                worker =
                    await window.Tesseract.createWorker(
                        "eng"
                    );


                console.log(
                    "[OCR] Tesseract.js initialized:",
                    OCR_VERSION
                );


                return worker;

            })();


        try {

            return await initializing;

        } finally {

            initializing = null;

        }

    }


    // ========================================================
    // TERMINATE OCR WORKER
    // ========================================================

    async function terminateOCR() {

        if (!worker) {

            return;

        }


        try {

            await worker.terminate();

        } finally {

            worker = null;


            console.log(
                "[OCR] Worker terminated."
            );

        }

    }


    // ========================================================
    // DATA URL → IMAGE
    // ========================================================

    function loadImage(
        imageSource
    ) {

        return new Promise(
            function (
                resolve,
                reject
            ) {

                const image =
                    new Image();


                image.onload =
                    function () {

                        resolve(image);

                    };


                image.onerror =
                    function () {

                        reject(
                            new Error(
                                "OCR could not load screenshot image."
                            )
                        );

                    };


                image.src =
                    imageSource;

            }
        );

    }


    // ========================================================
    // NORMALIZE OCR WORD
    // ========================================================

    function normalizeWord(
        word,
        imageWidth,
        imageHeight
    ) {

        if (
            !word ||
            typeof word !==
                "object"
        ) {

            return null;

        }


        const text =
            String(
                word.text || ""
            ).trim();


        if (!text) {

            return null;

        }


        const bbox =
            word.bbox;


        if (!bbox) {

            return null;

        }


        const left =
            Number(
                bbox.x0
            );


        const top =
            Number(
                bbox.y0
            );


        const right =
            Number(
                bbox.x1
            );


        const bottom =
            Number(
                bbox.y1
            );


        if (
            !Number.isFinite(left) ||
            !Number.isFinite(top) ||
            !Number.isFinite(right) ||
            !Number.isFinite(bottom)
        ) {

            return null;

        }


        const width =
            Math.max(
                0,
                right - left
            );


        const height =
            Math.max(
                0,
                bottom - top
            );


        if (
            width <= 0 ||
            height <= 0
        ) {

            return null;

        }


        let confidence =
            Number(
                word.confidence
            );


        if (
            !Number.isFinite(
                confidence
            )
        ) {

            confidence = 0;

        }


        confidence =
            Math.max(
                0,
                Math.min(
                    100,
                    confidence
                )
            );


        return {

            text,

            confidence,

            rect: {

                left,

                top,

                right,

                bottom,

                width,

                height

            },

            normalized: {

                left:
                    imageWidth > 0
                        ? left /
                          imageWidth
                        : 0,

                top:
                    imageHeight > 0
                        ? top /
                          imageHeight
                        : 0,

                right:
                    imageWidth > 0
                        ? right /
                          imageWidth
                        : 0,

                bottom:
                    imageHeight > 0
                        ? bottom /
                          imageHeight
                        : 0

            }

        };

    }


    // ========================================================
    // OCR SCREENSHOT
    // ========================================================

    async function testScreenshot(
        screenshot
    ) {

        if (
            typeof screenshot !==
                "string" ||
            screenshot.length === 0
        ) {

            throw new Error(
                "OCR screenshot is empty."
            );

        }


        const start =
            performance.now();


        // ----------------------------------------------------
        // INITIALIZE WORKER
        // ----------------------------------------------------

        const ocrWorker =
            await initializeOCR();


        // ----------------------------------------------------
        // RUN TESSERACT
        // ----------------------------------------------------

        console.log(
            "[OCR] Processing screenshot locally..."
        );


       const result =
    await ocrWorker.recognize(
        screenshot,
        {},
        {
            text: true,
            blocks: true
        }
    );


        const image =
            await loadImage(
                screenshot
            );


        const imageWidth =
            image.naturalWidth ||
            image.width;


        const imageHeight =
            image.naturalHeight ||
            image.height;


        // ----------------------------------------------------
        // EXTRACT WORDS
        // ----------------------------------------------------

        const rawText =
    String(
        result?.data?.text || ""
    ).trim();

const rawWords = [];

const blocks = Array.isArray(result?.data?.blocks)
    ? result.data.blocks
    : [];

for (const block of blocks) {

    const paragraphs =
        Array.isArray(block?.paragraphs)
            ? block.paragraphs
            : [];

    for (const paragraph of paragraphs) {

        const lines =
            Array.isArray(paragraph?.lines)
                ? paragraph.lines
                : [];

        for (const line of lines) {

            const words =
                Array.isArray(line?.words)
                    ? line.words
                    : [];

            for (const word of words) {

                if (word && typeof word === "object") {
                    rawWords.push(word);
                }

            }

        }
    }
}

console.log(
    "[OCR] Raw OCR output:",
    `textLength=${rawText.length}`,
    `words=${rawWords.length}`,
    `blocks=${blocks.length}`
);


        const words = [];


        for (
            const rawWord
            of rawWords
        ) {

            const normalized =
                normalizeWord(
                    rawWord,
                    imageWidth,
                    imageHeight
                );


            if (normalized) {

                words.push(
                    normalized
                );

            }

        }


        const latency =
            performance.now() -
            start;


        // ----------------------------------------------------
        // UPDATE BENCHMARK
        // ----------------------------------------------------

        ocrMetrics.runs += 1;

        ocrMetrics.totalLatencyMs +=
            latency;

        ocrMetrics.lastLatencyMs =
            latency;

        ocrMetrics.lastWordCount =
            words.length;

        ocrMetrics.totalWords +=
            words.length;


        // ----------------------------------------------------
        // SAFE LOGGING
        // ----------------------------------------------------

        /*
         * IMPORTANT:
         *
         * We intentionally DO NOT log
         * the actual OCR text here.
         *
         * This prevents sensitive OCR
         * content from appearing in logs.
         */

        console.log(
            "[OCR] Completed:",
            `${latency.toFixed(2)} ms`,
            `| words=${words.length}`,
            `| image=${imageWidth}x${imageHeight}`
        );


        console.log(
            "[OCR] Bounding boxes available:",
            words.length
        );


        // ----------------------------------------------------
        // RETURN LOCAL RESULT
        // ----------------------------------------------------

        return {

            success: true,

            version:
                OCR_VERSION,

            latencyMs:
                latency,

            image: {

                width:
                    imageWidth,

                height:
                    imageHeight

            },

            words,

            wordCount:
                words.length

        };

    }


    // ========================================================
    // BENCHMARK
    // ========================================================

    function getMetrics() {

        const averageLatency =
            ocrMetrics.runs > 0
                ? ocrMetrics.totalLatencyMs /
                  ocrMetrics.runs
                : 0;


        const averageWords =
            ocrMetrics.runs > 0
                ? ocrMetrics.totalWords /
                  ocrMetrics.runs
                : 0;


        return {

            version:
                OCR_VERSION,

            runs:
                ocrMetrics.runs,

            lastLatencyMs:
                Number(
                    ocrMetrics.lastLatencyMs.toFixed(2)
                ),

            averageLatencyMs:
                Number(
                    averageLatency.toFixed(2)
                ),

            lastWordCount:
                ocrMetrics.lastWordCount,

            averageWordCount:
                Number(
                    averageWords.toFixed(2)
                ),

            totalWords:
                ocrMetrics.totalWords

        };

    }


    // ========================================================
    // PUBLIC API
    // ========================================================

    window.SIHOCR = {

        version:
            OCR_VERSION,

        initialize:
            initializeOCR,

        terminate:
            terminateOCR,

        isReady:
            function () {

                return Boolean(
                    worker
                );

            },

        testScreenshot:
            testScreenshot,

        getMetrics:
            getMetrics

    };


    // ========================================================
    // MODULE LOADED
    // ========================================================

    console.log(
        "[OCR] OCR module loaded:",
        OCR_VERSION
    );

})();