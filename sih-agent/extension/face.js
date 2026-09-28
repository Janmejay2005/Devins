// ============================================================
// SIH PRIVACY BROWSER AGENT
// face.js
// Phase 3 — Local Face Detection
// ============================================================

(function () {

    "use strict";

    const FACE_VERSION = "3.8.0";

    const FACE_CONFIDENCE_THRESHOLD = 0.70;

    const MAX_INFERENCE_DIMENSION = 1280;

    const STANDARD_TILE = 512;
    const SMALL_TILE = 384;
    const TINY_TILE = 256;

    const TILE_OVERLAP = 0.20;

    const MIN_FACE_SIZE = 8;

    const MERGE_IOU_THRESHOLD = 0.35;

    const MAX_TILES_PER_PASS = 48;
    let model = null;

    let initialized = false;

    let initializing = null;

    let activeModelURL = "";

    const metrics = {

        modelLoadLatencyMs: 0,

        modelSource: "none",

        detectionRuns: 0,

        inferenceRuns: 0,

        totalDetectionLatencyMs: 0,

        totalInferenceLatencyMs: 0,

        detectedFaces: 0,

        rawPredictions: 0,

        acceptedPredictions: 0,

        rejectedPredictions: 0,

        invalidPredictions: 0,

        errors: 0,

        confidenceSamples: [],

        lastRawPredictionCount: 0,

        lastAcceptedFaceCount: 0,

        lastInferenceLatencyMs: 0,

        lastSourceWidth: 0,

        lastSourceHeight: 0,

        lastInferenceWidth: 0,

        lastInferenceHeight: 0
    };


    // ========================================================
    // DEPENDENCIES
    // ========================================================

    function checkDependencies() {

        if (!window.tf) {

            throw new Error(
                "TensorFlow.js is not available."
            );

        }

        if (!window.blazeface) {

            throw new Error(
                "BlazeFace library is not available."
            );

        }

    }


    // ========================================================
    // EXTENSION URL
    // ========================================================

    function getExtensionURL(path) {

        try {

            if (
                typeof chrome !== "undefined" &&
                chrome.runtime &&
                typeof chrome.runtime.getURL === "function"
            ) {

                return chrome.runtime.getURL(path);

            }

        } catch (_) {}

        try {

            if (
                typeof browser !== "undefined" &&
                browser.runtime &&
                typeof browser.runtime.getURL === "function"
            ) {

                return browser.runtime.getURL(path);

            }

        } catch (_) {}

        return path;
    }


    // ========================================================
    // LOCAL MODEL PATHS
    // ========================================================

    function getLocalModelURLs() {

        return LOCAL_MODEL_PATHS.map(
            getExtensionURL
        );

    }


    // ========================================================
    // MODEL INITIALIZATION
    // ========================================================

    async function initialize() {

    if (
        initialized &&
        model
    ) {
        return true;
    }

    if (initializing) {
        return initializing;
    }

    initializing = (async function () {

        const start =
            performance.now();

        try {

            checkDependencies();

            console.log(
                "[FACE] TensorFlow.js:",
                window.tf.version?.tfjs ||
                "unknown"
            );

            await window.tf.ready();

            console.log(
                "[FACE] TensorFlow backend:",
                window.tf.getBackend()
            );

            console.log(
                "[FACE] Loading BlazeFace model..."
            );

            model =
                await window.blazeface.load({
                    maxFaces:
                        20,

                    inputWidth:
                        128,

                    inputHeight:
                        128,

                    iouThreshold:
                        0.30,

                    scoreThreshold:
                        0.75
                });

            if (!model) {
                throw new Error(
                    "BlazeFace model returned no model."
                );
            }

            initialized =
                true;

            activeModelURL =
                "tfhub-default";

            metrics.modelSource =
                "remote";

            metrics.modelLoadLatencyMs =
                performance.now() -
                start;

            console.log(
                "[FACE] BlazeFace initialized:",
                `${metrics.modelLoadLatencyMs.toFixed(2)} ms`
            );

            return true;

        } catch (error) {

            initialized =
                false;

            model =
                null;

            activeModelURL =
                "";

            metrics.modelSource =
                "none";

            metrics.errors++;

            console.error(
                "[FACE] Initialization failed:",
                error?.message ||
                error
            );

            return false;

        } finally {

            initializing =
                null;
        }

    })();

    return initializing;
}

    // ========================================================
    // IMAGE LOADING
    // ========================================================

    function loadImageFromDataURL(
        dataURL
    ) {

        return new Promise(
            function (
                resolve,
                reject
            ) {

                if (
                    typeof dataURL !== "string" ||
                    !dataURL.startsWith(
                        "data:image/"
                    )
                ) {

                    reject(
                        new Error(
                            "Invalid screenshot data URL."
                        )
                    );

                    return;
                }


                const image =
                    new Image();


                image.onload =
                    function () {

                        resolve(
                            image
                        );

                    };


                image.onerror =
                    function () {

                        reject(
                            new Error(
                                "Screenshot image could not be loaded."
                            )
                        );

                    };


                image.src =
                    dataURL;

            }
        );
    }


    // ========================================================
    // INPUT RESOLUTION
    // ========================================================

    async function resolveSource(
        context
    ) {

        if (!context) {

            return null;
        }


        if (
            typeof HTMLImageElement !==
                "undefined" &&
            context instanceof
                HTMLImageElement
        ) {

            return context;
        }


        if (
            typeof HTMLCanvasElement !==
                "undefined" &&
            context instanceof
                HTMLCanvasElement
        ) {

            return context;
        }


        if (
            typeof ImageBitmap !==
                "undefined" &&
            context instanceof
                ImageBitmap
        ) {

            return context;
        }


        if (
            context.image
        ) {

            return context.image;
        }


        if (
            context.canvas
        ) {

            return context.canvas;
        }


        if (
            context.screenshotCanvas
        ) {

            return context.screenshotCanvas;
        }


        const candidates = [

            context.screenshot,

            context.screenshotDataUrl,

            context.screenshot_data_url,

            context.dataURL,

            context.dataUrl

        ];


        for (
            const value of candidates
        ) {

            if (
                typeof value === "string" &&
                value.startsWith(
                    "data:image/"
                )
            ) {

                return loadImageFromDataURL(
                    value
                );

            }

        }


        return null;
    }


    // ========================================================
    // CANVAS
    // ========================================================

    function createCanvas(
        width,
        height
    ) {

        const canvas =
            document.createElement(
                "canvas"
            );


        canvas.width =
            Math.max(
                1,
                Math.round(width)
            );


        canvas.height =
            Math.max(
                1,
                Math.round(height)
            );


        const ctx =
            canvas.getContext(
                "2d"
            );


        if (!ctx) {

            return null;
        }


        ctx.imageSmoothingEnabled =
            true;

        ctx.imageSmoothingQuality =
            "high";


        return {
            canvas,
            ctx
        };
    }


    // ========================================================
    // SOURCE -> INFERENCE CANVAS
    // ========================================================

    function createInferenceCanvas(
        source,
        sourceWidth,
        sourceHeight
    ) {

        const scale =
            Math.min(
                1,
                MAX_INFERENCE_DIMENSION /
                Math.max(
                    sourceWidth,
                    sourceHeight
                )
            );


        const width =
            Math.max(
                1,
                Math.round(
                    sourceWidth *
                    scale
                )
            );


        const height =
            Math.max(
                1,
                Math.round(
                    sourceHeight *
                    scale
                )
            );


        const result =
            createCanvas(
                width,
                height
            );


        if (!result) {

            return null;
        }


        result.ctx.drawImage(
            source,
            0,
            0,
            sourceWidth,
            sourceHeight,
            0,
            0,
            width,
            height
        );


        return {

            canvas:
                result.canvas,

            width,

            height,

            scale

        };
    }


    // ========================================================
    // CONFIDENCE
    // ========================================================

    function getConfidence(
        prediction
    ) {

        const probability =
            prediction?.probability;


        if (
            Array.isArray(
                probability
            )
        ) {

            return Number(
                probability[0]
            );
        }


        if (
            probability &&
            typeof probability.length ===
                "number"
        ) {

            return Number(
                probability[0]
            );
        }


        if (
            typeof probability ===
                "number"
        ) {

            return probability;
        }


        if (
            typeof prediction?.confidence ===
                "number"
        ) {

            return Number(
                prediction.confidence
            );
        }


        return NaN;
    }


    // ========================================================
    // RECT NORMALIZATION
    // ========================================================

    function normalizeRect(
        topLeft,
        bottomRight,
        width,
        height
    ) {

        if (
            !topLeft ||
            !bottomRight
        ) {

            return null;
        }


        const left =
            Number(
                topLeft[0]
            );


        const top =
            Number(
                topLeft[1]
            );


        const right =
            Number(
                bottomRight[0]
            );


        const bottom =
            Number(
                bottomRight[1]
            );


        if (
            !Number.isFinite(left) ||
            !Number.isFinite(top) ||
            !Number.isFinite(right) ||
            !Number.isFinite(bottom)
        ) {

            return null;
        }


        const safeLeft =
            Math.max(
                0,
                Math.min(
                    width,
                    left
                )
            );


        const safeTop =
            Math.max(
                0,
                Math.min(
                    height,
                    top
                )
            );


        const safeRight =
            Math.max(
                0,
                Math.min(
                    width,
                    right
                )
            );


        const safeBottom =
            Math.max(
                0,
                Math.min(
                    height,
                    bottom
                )
            );


        const rectWidth =
            safeRight -
            safeLeft;


        const rectHeight =
            safeBottom -
            safeTop;


        if (
            rectWidth <
                MIN_FACE_SIZE ||
            rectHeight <
                MIN_FACE_SIZE
        ) {

            return null;
        }


        return {

            left:
                safeLeft,

            top:
                safeTop,

            right:
                safeRight,

            bottom:
                safeBottom,

            width:
                rectWidth,

            height:
                rectHeight

        };
    }


    // ========================================================
    // MODEL RUN
    // ========================================================

    async function runModel(
        canvas
    ) {

        if (
            !model
        ) {

            throw new Error(
                "BlazeFace model is not initialized."
            );
        }


        if (
            window.tf &&
            typeof window.tf.engine ===
                "function"
        ) {

            window.tf
                .engine()
                .startScope();
        }


        const start =
            performance.now();


        try {

            metrics.inferenceRuns++;


            const predictions =
                await model.estimateFaces(
                    canvas,
                    false,
                    false
                );


            const list =
                Array.isArray(
                    predictions
                )
                    ? predictions
                    : [];


            return list;

        } finally {

            const latency =
                performance.now() -
                start;


            metrics.totalInferenceLatencyMs +=
                latency;


            metrics.lastInferenceLatencyMs =
                latency;


            if (
                window.tf &&
                typeof window.tf.engine ===
                    "function"
            ) {

                window.tf
                    .engine()
                    .endScope();
            }

        }
    }


    // ========================================================
    // TILE CREATION
    // ========================================================

    function createTiles(
        width,
        height,
        tileSize
    ) {

        const tiles = [];


        if (
            width <= tileSize &&
            height <= tileSize
        ) {

            return [

                {
                    x: 0,
                    y: 0,
                    width,
                    height
                }

            ];
        }


        const step =
            Math.max(
                1,
                Math.round(
                    tileSize *
                    (1 - TILE_OVERLAP)
                )
            );


        for (
            let y = 0;
            y < height;
            y += step
        ) {

            for (
                let x = 0;
                x < width;
                x += step
            ) {

                tiles.push({

                    x,

                    y,

                    width:
                        Math.min(
                            tileSize,
                            width - x
                        ),

                    height:
                        Math.min(
                            tileSize,
                            height - y
                        )

                });


                if (
                    tiles.length >=
                    MAX_TILES_PER_PASS
                ) {

                    return tiles;
                }


                if (
                    x + tileSize >=
                    width
                ) {

                    break;
                }
            }


            if (
                y + tileSize >=
                height
            ) {

                break;
            }
        }


        return tiles;
    }


    // ========================================================
    // TILE CANVAS
    // ========================================================

    function createTileCanvas(
        source,
        tile,
        targetSize
    ) {

        const longestSide =
            Math.max(
                tile.width,
                tile.height
            );


        const scale =
            Math.max(
                1,
                targetSize /
                longestSide
            );


        const width =
            Math.max(
                1,
                Math.round(
                    tile.width *
                    scale
                )
            );


        const height =
            Math.max(
                1,
                Math.round(
                    tile.height *
                    scale
                )
            );


        const result =
            createCanvas(
                width,
                height
            );


        if (!result) {

            return null;
        }


        result.ctx.drawImage(

            source,

            tile.x,
            tile.y,

            tile.width,
            tile.height,

            0,
            0,

            width,
            height

        );


        return {

            canvas:
                result.canvas,

            width,

            height,

            scale

        };
    }


    // ========================================================
    // PREDICTION -> DETECTION
    // ========================================================

    function convertPrediction(
        prediction,
        canvasWidth,
        canvasHeight,
        offsetX,
        offsetY,
        coordinateScale
    ) {

        const confidence =
            getConfidence(
                prediction
            );


        if (
            !Number.isFinite(
                confidence
            )
        ) {

            metrics.invalidPredictions++;

            return null;
        }


        if (
            confidence <
            FACE_CONFIDENCE_THRESHOLD
        ) {

            metrics.rejectedPredictions++;

            return null;
        }


        const rect =
            normalizeRect(

                prediction.topLeft,

                prediction.bottomRight,

                canvasWidth,

                canvasHeight

            );


        if (!rect) {

            metrics.invalidPredictions++;

            return null;
        }


        const left =
            offsetX +
            rect.left /
            coordinateScale;


        const top =
            offsetY +
            rect.top /
            coordinateScale;


        const right =
            offsetX +
            rect.right /
            coordinateScale;


        const bottom =
            offsetY +
            rect.bottom /
            coordinateScale;


        return {

            type:
                "FACE",

            source:
                "vision",

            confidence,

            rect: {

                left,

                top,

                right,

                bottom,

                width:
                    right - left,

                height:
                    bottom - top

            }

        };
    }


    // ========================================================
    // FULL IMAGE PASS
    // ========================================================

    async function detectFullImage(
        canvas
    ) {

        const predictions =
            await runModel(
                canvas
            );


        metrics.rawPredictions +=
            predictions.length;


        metrics.lastRawPredictionCount +=
            predictions.length;


        const detections = [];


        for (
            const prediction of
            predictions
        ) {

            const detection =
                convertPrediction(

                    prediction,

                    canvas.width,

                    canvas.height,

                    0,

                    0,

                    1

                );


            if (
                detection
            ) {

                detections.push(
                    detection
                );

            }
        }


        return detections;
    }


    // ========================================================
    // TILED PASS
    // ========================================================

    async function detectTiles(
        canvas,
        tileSize
    ) {

        const tiles =
            createTiles(

                canvas.width,

                canvas.height,

                tileSize

            );


        console.log(
            `[FACE] ${tileSize}px pass | tiles=${tiles.length}`
        );


        const detections = [];


        for (
            let i = 0;
            i < tiles.length;
            i++
        ) {

            const tile =
                tiles[i];


            const tileCanvas =
                createTileCanvas(

                    canvas,

                    tile,

                    STANDARD_TILE

                );


            if (!tileCanvas) {

                metrics.invalidPredictions++;

                continue;
            }


            let predictions = [];


            try {

                predictions =
                    await runModel(
                        tileCanvas.canvas
                    );

            } catch (error) {

                metrics.errors++;


                console.warn(
                    `[FACE] Tile ${i + 1} failed:`,
                    error?.message ||
                    error
                );


                continue;
            }


            metrics.rawPredictions +=
                predictions.length;


            metrics.lastRawPredictionCount +=
                predictions.length;


            for (
                const prediction of
                predictions
            ) {

                const detection =
                    convertPrediction(

                        prediction,

                        tileCanvas.width,

                        tileCanvas.height,

                        tile.x,

                        tile.y,

                        tileCanvas.scale

                    );


                if (
                    detection
                ) {

                    detections.push(
                        detection
                    );

                }
            }
        }


        return detections;
    }


    // ========================================================
    // IOU
    // ========================================================

    function calculateIoU(
        a,
        b
    ) {

        const left =
            Math.max(
                a.rect.left,
                b.rect.left
            );


        const top =
            Math.max(
                a.rect.top,
                b.rect.top
            );


        const right =
            Math.min(
                a.rect.right,
                b.rect.right
            );


        const bottom =
            Math.min(
                a.rect.bottom,
                b.rect.bottom
            );


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


        const intersection =
            width *
            height;


        if (
            intersection <= 0
        ) {

            return 0;
        }


        const areaA =
            a.rect.width *
            a.rect.height;


        const areaB =
            b.rect.width *
            b.rect.height;


        const union =
            areaA +
            areaB -
            intersection;


        if (
            union <= 0
        ) {

            return 0;
        }


        return (
            intersection /
            union
        );
    }


    // ========================================================
    // MERGE DUPLICATES
    // ========================================================

    function mergeDetections(
        detections
    ) {

        const sorted =
            detections
                .slice()
                .sort(
                    function (
                        a,
                        b
                    ) {

                        return (
                            b.confidence -
                            a.confidence
                        );

                    }
                );


        const merged = [];


        for (
            const detection of
            sorted
        ) {

            let duplicate =
                false;


            for (
                const existing of
                merged
            ) {

                const iou =
                    calculateIoU(
                        detection,
                        existing
                    );


                const cxA =
                    detection.rect.left +
                    detection.rect.width /
                    2;


                const cyA =
                    detection.rect.top +
                    detection.rect.height /
                    2;


                const cxB =
                    existing.rect.left +
                    existing.rect.width /
                    2;


                const cyB =
                    existing.rect.top +
                    existing.rect.height /
                    2;


                const distance =
                    Math.sqrt(

                        Math.pow(
                            cxA - cxB,
                            2
                        ) +

                        Math.pow(
                            cyA - cyB,
                            2
                        )

                    );


                const minSize =
                    Math.min(

                        detection.rect.width,

                        detection.rect.height,

                        existing.rect.width,

                        existing.rect.height

                    );


                const sameFace =
                    iou >=
                    MERGE_IOU_THRESHOLD ||
                    distance <=
                    minSize * 0.50;


                if (
                    sameFace
                ) {

                    duplicate =
                        true;


                    if (
                        detection.confidence >
                        existing.confidence
                    ) {

                        Object.assign(
                            existing,
                            detection
                        );

                    }


                    break;
                }
            }


            if (
                !duplicate
            ) {

                merged.push(
                    detection
                );

            }

        }


        return merged;
    }


    // ========================================================
    // DETECT
    // ========================================================

    async function detect(
        context = {}
    ) {

        const start =
            performance.now();


        metrics.detectionRuns++;

        metrics.lastRawPredictionCount = 0;

        metrics.lastAcceptedFaceCount = 0;


        try {

            const ready =
                await initialize();


            if (!ready) {

                throw new Error(
                    "BlazeFace model is unavailable."
                );
            }


            const source =
                await resolveSource(
                    context
                );


            if (!source) {

                throw new Error(
                    "No valid screenshot source was provided."
                );
            }


            const sourceWidth =
                Number(
                    source.naturalWidth ||
                    source.videoWidth ||
                    source.width
                );


            const sourceHeight =
                Number(
                    source.naturalHeight ||
                    source.videoHeight ||
                    source.height
                );


            if (
                !Number.isFinite(
                    sourceWidth
                ) ||
                !Number.isFinite(
                    sourceHeight
                ) ||
                sourceWidth <= 0 ||
                sourceHeight <= 0
            ) {

                throw new Error(
                    "Invalid screenshot dimensions."
                );
            }


            metrics.lastSourceWidth =
                sourceWidth;

            metrics.lastSourceHeight =
                sourceHeight;


            console.log(
                `[FACE] Image dimensions=${sourceWidth}x${sourceHeight}`
            );


            const inference =
                createInferenceCanvas(

                    source,

                    sourceWidth,

                    sourceHeight

                );


            if (!inference) {

                throw new Error(
                    "Could not create inference canvas."
                );
            }


            metrics.lastInferenceWidth =
                inference.width;

            metrics.lastInferenceHeight =
                inference.height;


            const allDetections = [];


            // ------------------------------------------------
            // FULL IMAGE
            // ------------------------------------------------

            const fullDetections =
                await detectFullImage(
                    inference.canvas
                );


            allDetections.push(
                ...fullDetections
            );


            // ------------------------------------------------
            // STANDARD
            // ------------------------------------------------

            const standardDetections =
                await detectTiles(

                    inference.canvas,

                    STANDARD_TILE

                );


            allDetections.push(
                ...standardDetections
            );


            // ------------------------------------------------
            // SMALL FACE
            // ------------------------------------------------

            const smallDetections =
                await detectTiles(

                    inference.canvas,

                    SMALL_TILE

                );


            allDetections.push(
                ...smallDetections
            );


            // ------------------------------------------------
            // TINY FACE
            // ------------------------------------------------

            const tinyDetections =
                await detectTiles(

                    inference.canvas,

                    TINY_TILE

                );


            allDetections.push(
                ...tinyDetections
            );


            // ------------------------------------------------
            // MAP BACK TO SOURCE COORDINATES
            // ------------------------------------------------

            const scaleBack =
                1 /
                inference.scale;


            const sourceDetections =
                allDetections.map(

                    function (
                        detection
                    ) {

                        return {

                            type:
                                detection.type,

                            source:
                                detection.source,

                            confidence:
                                detection.confidence,

                            rect: {

                                left:
                                    detection.rect.left *
                                    scaleBack,

                                top:
                                    detection.rect.top *
                                    scaleBack,

                                right:
                                    detection.rect.right *
                                    scaleBack,

                                bottom:
                                    detection.rect.bottom *
                                    scaleBack,

                                width:
                                    detection.rect.width *
                                    scaleBack,

                                height:
                                    detection.rect.height *
                                    scaleBack

                            }

                        };

                    }
                );


            console.log(
                "[FACE] Validated detections before merge:",
                sourceDetections.length
            );


            const merged =
                mergeDetections(
                    sourceDetections
                );


            metrics.acceptedPredictions +=
                merged.length;


            metrics.lastAcceptedFaceCount =
                merged.length;


            metrics.detectedFaces +=
                merged.length;


            for (
                const detection of
                merged
            ) {

                metrics.confidenceSamples.push(
                    detection.confidence
                );

            }


            console.log(
                "[FACE] Final merged faces:",
                merged.length
            );


            return merged;

        } catch (error) {

            metrics.errors++;


            console.error(
                "[FACE] Detection failed:",
                error?.message ||
                error
            );


            /*
             * IMPORTANT
             *
             * Do not silently convert model failure
             * into a successful privacy result.
             *
             * content.js already fails closed.
             */

            throw error;

        } finally {

            const latency =
                performance.now() -
                start;


            metrics.totalDetectionLatencyMs +=
                latency;


            console.log(
                "[FACE] Inference:",
                `${latency.toFixed(2)} ms`,
                `| faces=${metrics.lastAcceptedFaceCount}`
            );

        }
    }


    // ========================================================
    // METRICS
    // ========================================================

    function getMetrics() {

        const samples =
            metrics.confidenceSamples;


        const averageConfidence =
            samples.length
                ? samples.reduce(
                    function (
                        sum,
                        value
                    ) {

                        return (
                            sum +
                            value
                        );

                    },
                    0
                ) /
                samples.length
                : 0;


        const averageDetectionLatency =
            metrics.detectionRuns
                ? metrics.totalDetectionLatencyMs /
                  metrics.detectionRuns
                : 0;


        const averageInferenceLatency =
            metrics.inferenceRuns
                ? metrics.totalInferenceLatencyMs /
                  metrics.inferenceRuns
                : 0;


        return {

            version:
                FACE_VERSION,

            threshold:
                FACE_CONFIDENCE_THRESHOLD,

            modelLoaded:
                initialized,

            modelSource:
                metrics.modelSource,

            modelURL:
                activeModelURL,

            modelLoadLatencyMs:
                Number(
                    metrics.modelLoadLatencyMs.toFixed(2)
                ),

            detectionRuns:
                metrics.detectionRuns,

            inferenceRuns:
                metrics.inferenceRuns,

            averageDetectionLatencyMs:
                Number(
                    averageDetectionLatency.toFixed(2)
                ),

            averageInferenceLatencyMs:
                Number(
                    averageInferenceLatency.toFixed(2)
                ),

            lastInferenceLatencyMs:
                Number(
                    metrics.lastInferenceLatencyMs.toFixed(2)
                ),

            rawPredictions:
                metrics.rawPredictions,

            lastRawPredictionCount:
                metrics.lastRawPredictionCount,

            acceptedPredictions:
                metrics.acceptedPredictions,

            lastAcceptedFaceCount:
                metrics.lastAcceptedFaceCount,

            detectedFaces:
                metrics.detectedFaces,

            rejectedPredictions:
                metrics.rejectedPredictions,

            invalidPredictions:
                metrics.invalidPredictions,

            averageConfidence:
                Number(
                    averageConfidence.toFixed(4)
                ),

            sourceWidth:
                metrics.lastSourceWidth,

            sourceHeight:
                metrics.lastSourceHeight,

            inferenceWidth:
                metrics.lastInferenceWidth,

            inferenceHeight:
                metrics.lastInferenceHeight,

            errors:
                metrics.errors
        };
    }


    // ========================================================
    // RESET
    // ========================================================

    function resetMetrics() {

        metrics.modelLoadLatencyMs = 0;

        metrics.modelSource =
            initialized
                ? metrics.modelSource
                : "none";

        metrics.detectionRuns = 0;

        metrics.inferenceRuns = 0;

        metrics.totalDetectionLatencyMs = 0;

        metrics.totalInferenceLatencyMs = 0;

        metrics.detectedFaces = 0;

        metrics.rawPredictions = 0;

        metrics.acceptedPredictions = 0;

        metrics.rejectedPredictions = 0;

        metrics.invalidPredictions = 0;

        metrics.errors = 0;

        metrics.confidenceSamples = [];

        metrics.lastRawPredictionCount = 0;

        metrics.lastAcceptedFaceCount = 0;

        metrics.lastInferenceLatencyMs = 0;

        metrics.lastSourceWidth = 0;

        metrics.lastSourceHeight = 0;

        metrics.lastInferenceWidth = 0;

        metrics.lastInferenceHeight = 0;
    }


    // ========================================================
    // PUBLIC API
    // ========================================================

    window.SIHFace = {

        version:
            FACE_VERSION,

        initialize,

        detect,

        getMetrics,

        resetMetrics,

        threshold:
            FACE_CONFIDENCE_THRESHOLD,

        maxInferenceDimension:
            MAX_INFERENCE_DIMENSION,

        modelSource:
            function () {

                return metrics.modelSource;

            },

        isReady:
            function () {

                return (
                    initialized &&
                    !!model
                );

            }
    };


    console.log(
        "[FACE] SIH Face module loaded | version=",
        FACE_VERSION
    );

})();