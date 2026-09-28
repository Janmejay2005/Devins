/* ============================================================
 * SIH PRIVACY BROWSER AGENT
 * Face Detection Module
 *
 * Version: 3.7.3
 *
 * Main fixes:
 *   1. Robust screenshot input adapter
 *   2. Supports nested screenshot payloads
 *   3. Supports data URLs / blob URLs / Blob
 *   4. Supports Image / ImageBitmap / Canvas / Video
 *   5. Keeps landmark rejection disabled
 *   6. Keeps geometry validation
 *   7. Keeps 512 / 384 / 256 detection passes
 *   8. Keeps duplicate suppression
 *
 * ============================================================ */

(() => {
    "use strict";

    const FACE_VERSION = "3.7.3";

    /* ============================================================
     * CONFIG
     * ============================================================ */

    const FACE_CONFIDENCE_THRESHOLD = 0.50;

    const MAX_INFERENCE_DIMENSION = 1280;

    const STANDARD_TILE_SIZE = 512;
    const SMALL_TILE_SIZE = 384;
    const TINY_TILE_SIZE = 256;

    const TILE_OVERLAP = 0.25;

    const MIN_FACE_SIZE = 8;
    const MIN_VALID_FACE_SIZE = 20;

    const MIN_FACE_ASPECT_RATIO = 0.55;
    const MAX_FACE_ASPECT_RATIO = 1.65;

    const MAX_SCREEN_FACE_RATIO = 0.75;

    const MERGE_IOU_THRESHOLD = 0.30;
    const DUPLICATE_CENTER_DISTANCE_FACTOR = 0.65;
    const DUPLICATE_SIZE_RATIO = 1.80;

    /* ============================================================
     * METRICS
     * ============================================================ */

    const metrics = {
        version: FACE_VERSION,

        inferenceTime: 0,

        rawDetections: 0,

        standardRaw: 0,
        standardValidated: 0,

        smallRaw: 0,
        smallValidated: 0,

        tinyRaw: 0,
        tinyValidated: 0,

        geometryRejected: 0,

        landmarkRejected: 0,

        duplicateMerged: 0,

        finalFaces: 0
    };

    /* ============================================================
     * MODEL
     * ============================================================ */

    let model = null;
    let initialized = false;

    /* ============================================================
     * DEPENDENCIES
     * ============================================================ */

    async function ensureDependencies() {
        if (initialized && model) {
            return model;
        }

        if (typeof tf === "undefined") {
            throw new Error(
                "[FACE] TensorFlow.js is not available."
            );
        }

        console.log(
            `[FACE] TensorFlow.js detected | version=${tf.version?.tfjs || "unknown"}`
        );

        try {
            if (tf.getBackend() !== "webgl") {
                try {
                    await tf.setBackend("webgl");
                    await tf.ready();
                } catch (error) {
                    console.warn(
                        "[FACE] WebGL unavailable, using current backend.",
                        error
                    );
                }
            }

            await tf.ready();

            console.log(
                `[FACE] TensorFlow backend=${tf.getBackend()}`
            );
        } catch (error) {
            console.warn(
                "[FACE] TensorFlow initialization warning:",
                error
            );
        }

        if (typeof blazeface === "undefined") {
            throw new Error(
                "[FACE] BlazeFace library is not available."
            );
        }

        console.log(
            "[FACE] BlazeFace API available."
        );

        model = await blazeface.load({
            maxFaces: 50,
            inputWidth: 128,
            inputHeight: 128
        });

        initialized = true;

        console.log(
            `[FACE] BlazeFace initialized | version=${FACE_VERSION}`
        );

        return model;
    }

    /* ============================================================
     * INPUT TYPE HELPERS
     * ============================================================ */

    function isString(value) {
        return typeof value === "string";
    }

    function isDataUrl(value) {
        return (
            isString(value) &&
            /^data:image\//i.test(value)
        );
    }

    function isBlobUrl(value) {
        return (
            isString(value) &&
            /^blob:/i.test(value)
        );
    }

    function isHttpImageUrl(value) {
        return (
            isString(value) &&
            /^(https?:|chrome-extension:|moz-extension:|file:)/i.test(value)
        );
    }

    function isCanvasLike(value) {
        return (
            value &&
            typeof value.getContext === "function" &&
            Number(value.width) > 0 &&
            Number(value.height) > 0
        );
    }

    function isImageBitmapLike(value) {
        return (
            typeof ImageBitmap !== "undefined" &&
            value instanceof ImageBitmap
        );
    }

    function isHTMLImage(value) {
        return (
            typeof HTMLImageElement !== "undefined" &&
            value instanceof HTMLImageElement
        );
    }

    function isHTMLVideo(value) {
        return (
            typeof HTMLVideoElement !== "undefined" &&
            value instanceof HTMLVideoElement
        );
    }

    function isBlob(value) {
        return (
            typeof Blob !== "undefined" &&
            value instanceof Blob
        );
    }

    function isArrayBuffer(value) {
        return (
            typeof ArrayBuffer !== "undefined" &&
            value instanceof ArrayBuffer
        );
    }

    /* ============================================================
     * OBJECT DEBUG
     * ============================================================ */

    function describeInput(value) {
        if (value === null) {
            return "null";
        }

        if (value === undefined) {
            return "undefined";
        }

        if (typeof value === "string") {
            return `string(length=${value.length}, prefix=${value.slice(0, 40)})`;
        }

        if (typeof value !== "object") {
            return typeof value;
        }

        const details = [];

        try {
            details.push(
                `constructor=${value.constructor?.name || "unknown"}`
            );
        } catch (_) {}

        try {
            details.push(
                `keys=${Object.keys(value).slice(0, 30).join(",")}`
            );
        } catch (_) {}

        try {
            if (value.width !== undefined) {
                details.push(
                    `width=${value.width}`
                );
            }

            if (value.height !== undefined) {
                details.push(
                    `height=${value.height}`
                );
            }
        } catch (_) {}

        return details.join(" | ");
    }

    /* ============================================================
     * URL → IMAGE
     * ============================================================ */

    async function loadImageFromUrl(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();

            image.onload = () => {
                resolve(image);
            };

            image.onerror = () => {
                reject(
                    new Error(
                        "[FACE] Failed to load screenshot URL."
                    )
                );
            };

            image.src = url;
        });
    }

    /* ============================================================
     * BLOB → IMAGE
     * ============================================================ */

    async function loadImageFromBlob(blob) {
        if (
            typeof createImageBitmap === "function"
        ) {
            try {
                const bitmap =
                    await createImageBitmap(blob);

                return bitmap;
            } catch (error) {
                console.warn(
                    "[FACE] createImageBitmap failed.",
                    error
                );
            }
        }

        const objectUrl =
            URL.createObjectURL(blob);

        try {
            return await loadImageFromUrl(
                objectUrl
            );
        } finally {
            URL.revokeObjectURL(
                objectUrl
            );
        }
    }

    /* ============================================================
     * ARRAYBUFFER → BLOB
     * ============================================================ */

    async function loadImageFromArrayBuffer(
        buffer
    ) {
        try {
            const blob =
                new Blob(
                    [buffer],
                    {
                        type: "image/png"
                    }
                );

            return await loadImageFromBlob(
                blob
            );
        } catch (error) {
            throw new Error(
                "[FACE] Could not convert ArrayBuffer to image."
            );
        }
    }

    /* ============================================================
     * COMMON PROPERTY NAMES
     * ============================================================ */

    const IMAGE_KEYS = [
        "screenshot",
        "screenshotData",
        "screenshot_data",
        "screenshotDataUrl",
        "screenshot_data_url",
        "dataUrl",
        "dataURL",
        "data",
        "image",
        "imageData",
        "imageDataUrl",
        "image_data",
        "image_data_url",
        "src",
        "source",
        "url",
        "blob",
        "bitmap",
        "canvas",
        "capture",
        "captureData",
        "capture_data",
        "result",
        "payload"
    ];

    /* ============================================================
     * DIRECT VALUE RESOLUTION
     * ============================================================ */

    async function resolveDirectInput(
        value
    ) {
        if (!value) {
            return null;
        }

        /* --------------------------------------------------------
         * STRING
         * -------------------------------------------------------- */

        if (isString(value)) {
            const trimmed =
                value.trim();

            if (!trimmed) {
                return null;
            }

            /*
             * Data URL.
             */
            if (isDataUrl(trimmed)) {
                console.log(
                    "[FACE] Resolved input: data-url"
                );

                return await loadImageFromUrl(
                    trimmed
                );
            }

            /*
             * Blob URL.
             */
            if (isBlobUrl(trimmed)) {
                console.log(
                    "[FACE] Resolved input: blob-url"
                );

                return await loadImageFromUrl(
                    trimmed
                );
            }

            /*
             * Other URL-like screenshot.
             */
            if (isHttpImageUrl(trimmed)) {
                console.log(
                    "[FACE] Resolved input: URL"
                );

                return await loadImageFromUrl(
                    trimmed
                );
            }

            /*
             * Sometimes screenshot strings are
             * raw base64 without the data: prefix.
             */
            if (
                trimmed.length > 100 &&
                /^[A-Za-z0-9+/=\s]+$/.test(
                    trimmed
                )
            ) {
                try {
                    const dataUrl =
                        "data:image/png;base64," +
                        trimmed.replace(
                            /\s/g,
                            ""
                        );

                    console.log(
                        "[FACE] Resolved input: raw-base64"
                    );

                    return await loadImageFromUrl(
                        dataUrl
                    );
                } catch (_) {
                    return null;
                }
            }

            return null;
        }

        /* --------------------------------------------------------
         * BLOB
         * -------------------------------------------------------- */

        if (isBlob(value)) {
            console.log(
                `[FACE] Resolved input: Blob | type=${value.type || "unknown"} | size=${value.size}`
            );

            return await loadImageFromBlob(
                value
            );
        }

        /* --------------------------------------------------------
         * ARRAYBUFFER
         * -------------------------------------------------------- */

        if (isArrayBuffer(value)) {
            console.log(
                "[FACE] Resolved input: ArrayBuffer"
            );

            return await loadImageFromArrayBuffer(
                value
            );
        }

        /* --------------------------------------------------------
         * IMAGE
         * -------------------------------------------------------- */

        if (isHTMLImage(value)) {
            console.log(
                "[FACE] Resolved input: HTMLImageElement"
            );

            if (
                !value.complete ||
                value.naturalWidth === 0
            ) {
                await new Promise(
                    (resolve, reject) => {
                        value.onload =
                            resolve;

                        value.onerror =
                            reject;
                    }
                );
            }

            return value;
        }

        /* --------------------------------------------------------
         * IMAGE BITMAP
         * -------------------------------------------------------- */

        if (isImageBitmapLike(value)) {
            console.log(
                `[FACE] Resolved input: ImageBitmap | ${value.width}x${value.height}`
            );

            return value;
        }

        /* --------------------------------------------------------
         * CANVAS
         * -------------------------------------------------------- */

        if (isCanvasLike(value)) {
            console.log(
                `[FACE] Resolved input: Canvas | ${value.width}x${value.height}`
            );

            return value;
        }

        /* --------------------------------------------------------
         * VIDEO
         * -------------------------------------------------------- */

        if (isHTMLVideo(value)) {
            console.log(
                `[FACE] Resolved input: Video | ${value.videoWidth}x${value.videoHeight}`
            );

            return value;
        }

        return null;
    }

    /* ============================================================
     * RECURSIVE OBJECT RESOLUTION
     * ============================================================ */

    async function resolveScreenshotInput(
        source,
        visited = new Set(),
        depth = 0
    ) {
        if (
            source === null ||
            source === undefined
        ) {
            return null;
        }

        /*
         * Prevent infinite recursive objects.
         */
        if (depth > 6) {
            return null;
        }

        /*
         * Direct supported type.
         */
        const direct =
            await resolveDirectInput(
                source
            );

        if (direct) {
            return direct;
        }

        /*
         * Primitive that is not an image.
         */
        if (
            typeof source !== "object"
        ) {
            return null;
        }

        /*
         * Prevent cycles.
         */
        if (visited.has(source)) {
            return null;
        }

        visited.add(source);

        /* --------------------------------------------------------
         * FIRST: known screenshot keys
         * -------------------------------------------------------- */

        for (
            const key of IMAGE_KEYS
        ) {
            let value;

            try {
                value =
                    source[key];
            } catch (_) {
                continue;
            }

            if (
                value === undefined ||
                value === null ||
                value === source
            ) {
                continue;
            }

            const resolved =
                await resolveScreenshotInput(
                    value,
                    visited,
                    depth + 1
                );

            if (resolved) {
                console.log(
                    `[FACE] Resolved nested screenshot property: ${key}`
                );

                return resolved;
            }
        }

        /* --------------------------------------------------------
         * SECOND: inspect object values
         * -------------------------------------------------------- */

        let keys = [];

        try {
            keys =
                Object.keys(source);
        } catch (_) {
            keys = [];
        }

        for (
            const key of keys
        ) {
            if (
                IMAGE_KEYS.includes(key)
            ) {
                continue;
            }

            let value;

            try {
                value =
                    source[key];
            } catch (_) {
                continue;
            }

            if (
                value === undefined ||
                value === null ||
                value === source
            ) {
                continue;
            }

            /*
             * Only recursively inspect likely
             * image-related properties.
             */
            const keyLooksRelevant =
                /image|screen|capture|screenshot|data|source|canvas|bitmap|blob|url|src/i.test(
                    key
                );

            if (!keyLooksRelevant) {
                continue;
            }

            const resolved =
                await resolveScreenshotInput(
                    value,
                    visited,
                    depth + 1
                );

            if (resolved) {
                console.log(
                    `[FACE] Resolved inferred screenshot property: ${key}`
                );

                return resolved;
            }
        }

        return null;
    }

    /* ============================================================
     * NORMALIZE INPUT
     * ============================================================ */

    async function normalizeImageSource(
        source
    ) {
        const resolved =
            await resolveScreenshotInput(
                source
            );

        if (resolved) {
            return resolved;
        }

        console.error(
            "[FACE] Unable to resolve screenshot input."
        );

        console.error(
            "[FACE] Input description:",
            describeInput(source)
        );

        /*
         * Extra debugging for object payloads.
         */
        if (
            source &&
            typeof source === "object"
        ) {
            try {
                console.error(
                    "[FACE] Input keys:",
                    Object.keys(source)
                );
            } catch (_) {}
        }

        throw new Error(
            "[FACE] Unsupported screenshot input type."
        );
    }

    /* ============================================================
     * IMAGE DIMENSIONS
     * ============================================================ */

    function getImageDimensions(
        image
    ) {
        if (!image) {
            throw new Error(
                "[FACE] Invalid image source."
            );
        }

        let width = 0;
        let height = 0;

        if (isHTMLImage(image)) {
            width =
                Number(
                    image.naturalWidth
                ) ||
                Number(
                    image.width
                ) ||
                0;

            height =
                Number(
                    image.naturalHeight
                ) ||
                Number(
                    image.height
                ) ||
                0;
        }

        if (
            !width &&
            isImageBitmapLike(image)
        ) {
            width =
                Number(
                    image.width
                ) || 0;

            height =
                Number(
                    image.height
                ) || 0;
        }

        if (
            !width &&
            isCanvasLike(image)
        ) {
            width =
                Number(
                    image.width
                ) || 0;

            height =
                Number(
                    image.height
                ) || 0;
        }

        if (
            !width &&
            isHTMLVideo(image)
        ) {
            width =
                Number(
                    image.videoWidth
                ) ||
                Number(
                    image.width
                ) ||
                0;

            height =
                Number(
                    image.videoHeight
                ) ||
                Number(
                    image.height
                ) ||
                0;
        }

        if (!width) {
            width =
                Number(
                    image.naturalWidth
                ) ||
                Number(
                    image.videoWidth
                ) ||
                Number(
                    image.width
                ) ||
                0;

            height =
                Number(
                    image.naturalHeight
                ) ||
                Number(
                    image.videoHeight
                ) ||
                Number(
                    image.height
                ) ||
                0;
        }

        if (
            !Number.isFinite(width) ||
            !Number.isFinite(height) ||
            width <= 0 ||
            height <= 0
        ) {
            throw new Error(
                "[FACE] Could not determine image dimensions."
            );
        }

        return {
            width,
            height
        };
    }

    /* ============================================================
     * INFERENCE SCALE
     * ============================================================ */

    function calculateInferenceScale(
        width,
        height
    ) {
        const largestDimension =
            Math.max(
                width,
                height
            );

        if (
            largestDimension <=
            MAX_INFERENCE_DIMENSION
        ) {
            return 1;
        }

        return (
            MAX_INFERENCE_DIMENSION /
            largestDimension
        );
    }

    /* ============================================================
     * CANVAS
     * ============================================================ */

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

        return canvas;
    }

    function drawImageToCanvas(
        image,
        canvas,
        sourceX = 0,
        sourceY = 0,
        sourceWidth = null,
        sourceHeight = null
    ) {
        const ctx =
            canvas.getContext(
                "2d",
                {
                    willReadFrequently:
                        true
                }
            );

        if (!ctx) {
            throw new Error(
                "[FACE] Could not create canvas context."
            );
        }

        const dimensions =
            getImageDimensions(
                image
            );

        sourceWidth =
            sourceWidth ||
            dimensions.width;

        sourceHeight =
            sourceHeight ||
            dimensions.height;

        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        ctx.drawImage(
            image,

            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,

            0,
            0,
            canvas.width,
            canvas.height
        );

        return canvas;
    }

    /* ============================================================
     * RECT
     * ============================================================ */

    function normalizeRect(
        box
    ) {
        if (!box) {
            return null;
        }

        let x;
        let y;
        let width;
        let height;

        if (
            Array.isArray(box)
        ) {
            x =
                Number(
                    box[0]
                );

            y =
                Number(
                    box[1]
                );

            width =
                Number(
                    box[2]
                );

            height =
                Number(
                    box[3]
                );
        } else {
            x =
                Number(
                    box.x ??
                    box.left ??
                    0
                );

            y =
                Number(
                    box.y ??
                    box.top ??
                    0
                );

            if (
                box.width !==
                    undefined &&
                box.height !==
                    undefined
            ) {
                width =
                    Number(
                        box.width
                    );

                height =
                    Number(
                        box.height
                    );
            } else {
                const right =
                    Number(
                        box.right ??
                        x
                    );

                const bottom =
                    Number(
                        box.bottom ??
                        y
                    );

                width =
                    right - x;

                height =
                    bottom - y;
            }
        }

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(width) ||
            !Number.isFinite(height)
        ) {
            return null;
        }

        if (width < 0) {
            x += width;
            width =
                Math.abs(width);
        }

        if (height < 0) {
            y += height;
            height =
                Math.abs(height);
        }

        return {
            x,
            y,
            width,
            height
        };
    }

    /* ============================================================
     * CONFIDENCE
     * ============================================================ */

    function getConfidence(
        prediction
    ) {
        if (!prediction) {
            return 0;
        }

        const confidence =
            prediction.probability?.[0] ??
            prediction.confidence ??
            prediction.score ??
            0;

        const value =
            Number(
                confidence
            );

        return Number.isFinite(
            value
        )
            ? value
            : 0;
    }

    /* ============================================================
     * LANDMARKS
     *
     * Diagnostics only.
     * ============================================================ */

    function normalizeLandmarks(
        prediction
    ) {
        const landmarks =
            prediction?.landmarks ||
            prediction?.keypoints ||
            null;

        if (
            !Array.isArray(
                landmarks
            )
        ) {
            return [];
        }

        return landmarks
            .map(point => {
                if (!point) {
                    return null;
                }

                if (
                    Array.isArray(
                        point
                    )
                ) {
                    const x =
                        Number(
                            point[0]
                        );

                    const y =
                        Number(
                            point[1]
                        );

                    if (
                        Number.isFinite(x) &&
                        Number.isFinite(y)
                    ) {
                        return {
                            x,
                            y
                        };
                    }

                    return null;
                }

                const x =
                    Number(
                        point.x ??
                        point[0]
                    );

                const y =
                    Number(
                        point.y ??
                        point[1]
                    );

                if (
                    Number.isFinite(x) &&
                    Number.isFinite(y)
                ) {
                    return {
                        x,
                        y
                    };
                }

                return null;
            })
            .filter(Boolean);
    }

    /* ============================================================
     * GEOMETRY VALIDATION
     * ============================================================ */

    function validateFaceGeometry(
        rect,
        imageWidth,
        imageHeight
    ) {
        if (!rect) {
            return {
                valid: false,
                reason:
                    "invalid-rect"
            };
        }

        const {
            x,
            y,
            width,
            height
        } = rect;

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(width) ||
            !Number.isFinite(height)
        ) {
            return {
                valid: false,
                reason:
                    "non-finite-geometry"
            };
        }

        if (
            width <
                MIN_FACE_SIZE ||
            height <
                MIN_FACE_SIZE
        ) {
            return {
                valid: false,
                reason:
                    "too-small"
            };
        }

        if (
            width <
                MIN_VALID_FACE_SIZE ||
            height <
                MIN_VALID_FACE_SIZE
        ) {
            return {
                valid: false,
                reason:
                    "below-validation-size"
            };
        }

        const aspectRatio =
            width /
            height;

        if (
            aspectRatio <
                MIN_FACE_ASPECT_RATIO ||
            aspectRatio >
                MAX_FACE_ASPECT_RATIO
        ) {
            return {
                valid: false,
                reason:
                    "invalid-aspect-ratio"
            };
        }

        if (
            width >
                imageWidth *
                MAX_SCREEN_FACE_RATIO ||
            height >
                imageHeight *
                MAX_SCREEN_FACE_RATIO
        ) {
            return {
                valid: false,
                reason:
                    "too-large"
            };
        }

        if (
            x + width <= 0 ||
            y + height <= 0 ||
            x >= imageWidth ||
            y >= imageHeight
        ) {
            return {
                valid: false,
                reason:
                    "outside-image"
            };
        }

        return {
            valid: true
        };
    }

    /* ============================================================
     * MODEL EXECUTION
     * ============================================================ */

    async function runModel(
        input
    ) {
        await ensureDependencies();

        if (!model) {
            throw new Error(
                "[FACE] Model not initialized."
            );
        }

        try {
            const predictions =
                await model.estimateFaces(
                    input,
                    false
                );

            if (
                !Array.isArray(
                    predictions
                )
            ) {
                return [];
            }

            return predictions;
        } catch (error) {
            console.error(
                "[FACE] BlazeFace inference failed:",
                error
            );

            return [];
        }
    }

    /* ============================================================
     * TILES
     * ============================================================ */

    function createTiles(
        width,
        height,
        tileSize,
        overlap = TILE_OVERLAP
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
                Math.floor(
                    tileSize *
                    (1 - overlap)
                )
            );

        const xPositions = [];
        const yPositions = [];

        for (
            let x = 0;
            x < width;
            x += step
        ) {
            xPositions.push(
                Math.min(
                    x,
                    Math.max(
                        0,
                        width - tileSize
                    )
                )
            );

            if (
                x + tileSize >=
                width
            ) {
                break;
            }
        }

        for (
            let y = 0;
            y < height;
            y += step
        ) {
            yPositions.push(
                Math.min(
                    y,
                    Math.max(
                        0,
                        height - tileSize
                    )
                )
            );

            if (
                y + tileSize >=
                height
            ) {
                break;
            }
        }

        const uniqueX =
            [
                ...new Set(
                    xPositions
                )
            ];

        const uniqueY =
            [
                ...new Set(
                    yPositions
                )
            ];

        for (
            const y of uniqueY
        ) {
            for (
                const x of uniqueX
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
            }
        }

        return tiles;
    }

    function createTileCanvas(
        image,
        tile
    ) {
        const canvas =
            createCanvas(
                tile.width,
                tile.height
            );

        drawImageToCanvas(
            image,
            canvas,

            tile.x,
            tile.y,

            tile.width,
            tile.height
        );

        return canvas;
    }

    /* ============================================================
     * PREDICTION CONVERSION
     * ============================================================ */

    function convertPrediction(
        prediction,

        sourceX,
        sourceY,

        sourceWidth,
        sourceHeight,

        inferenceWidth,
        inferenceHeight,

        imageWidth,
        imageHeight
    ) {
        if (!prediction) {
            return null;
        }

        const confidence =
            getConfidence(
                prediction
            );

        if (
            confidence <
            FACE_CONFIDENCE_THRESHOLD
        ) {
            return null;
        }

        let rawBox = null;

        if (
            prediction.topLeft &&
            prediction.bottomRight
        ) {
            rawBox = {
                x:
                    Number(
                        prediction
                            .topLeft[0]
                    ),

                y:
                    Number(
                        prediction
                            .topLeft[1]
                    ),

                width:
                    Number(
                        prediction
                            .bottomRight[0]
                    ) -
                    Number(
                        prediction
                            .topLeft[0]
                    ),

                height:
                    Number(
                        prediction
                            .bottomRight[1]
                    ) -
                    Number(
                        prediction
                            .topLeft[1]
                    )
            };
        } else {
            rawBox =
                normalizeRect(
                    prediction.boundingBox ||
                    prediction.box ||
                    prediction
                );
        }

        if (!rawBox) {
            metrics.geometryRejected++;

            console.debug(
                "[FACE] Rejected | reason=invalid-rect"
            );

            return null;
        }

        const scaleX =
            sourceWidth /
            inferenceWidth;

        const scaleY =
            sourceHeight /
            inferenceHeight;

        const rect = {
            x:
                sourceX +
                rawBox.x *
                scaleX,

            y:
                sourceY +
                rawBox.y *
                scaleY,

            width:
                rawBox.width *
                scaleX,

            height:
                rawBox.height *
                scaleY
        };

        const geometry =
            validateFaceGeometry(
                rect,
                imageWidth,
                imageHeight
            );

        if (!geometry.valid) {
            metrics.geometryRejected++;

            console.debug(
                `[FACE] Rejected | confidence=${confidence.toFixed(4)} | reason=${geometry.reason}`
            );

            return null;
        }

        return {
            type:
                "FACE",

            source:
                "vision",

            confidence,

            rect,

            landmarks:
                normalizeLandmarks(
                    prediction
                )
        };
    }

    /* ============================================================
     * FULL IMAGE
     * ============================================================ */

    async function detectFullImage(
        image,
        imageWidth,
        imageHeight
    ) {
        const scale =
            calculateInferenceScale(
                imageWidth,
                imageHeight
            );

        const inferenceWidth =
            Math.max(
                1,
                Math.round(
                    imageWidth *
                    scale
                )
            );

        const inferenceHeight =
            Math.max(
                1,
                Math.round(
                    imageHeight *
                    scale
                )
            );

        const canvas =
            createCanvas(
                inferenceWidth,
                inferenceHeight
            );

        drawImageToCanvas(
            image,
            canvas,

            0,
            0,

            imageWidth,
            imageHeight
        );

        const predictions =
            await runModel(
                canvas
            );

        metrics.rawDetections +=
            predictions.length;

        console.log(
            `[FACE] Full image raw detections=${predictions.length}`
        );

        const detections = [];

        for (
            const prediction
            of predictions
        ) {
            const detection =
                convertPrediction(
                    prediction,

                    0,
                    0,

                    imageWidth,
                    imageHeight,

                    inferenceWidth,
                    inferenceHeight,

                    imageWidth,
                    imageHeight
                );

            if (detection) {
                detections.push(
                    detection
                );
            }
        }

        console.log(
            `[FACE] Full image validated=${detections.length}`
        );

        return detections;
    }

    /* ============================================================
     * TILE DETECTION
     * ============================================================ */

    async function detectTiles(
        image,
        imageWidth,
        imageHeight,
        tileSize,
        passName
    ) {
        const tiles =
            createTiles(
                imageWidth,
                imageHeight,
                tileSize,
                TILE_OVERLAP
            );

        console.log(
            `[FACE] ${passName} pass | tile=${tileSize} | tiles=${tiles.length}`
        );

        const detections = [];

        for (
            const tile of tiles
        ) {
            const tileCanvas =
                createTileCanvas(
                    image,
                    tile
                );

            const scale =
                calculateInferenceScale(
                    tile.width,
                    tile.height
                );

            const inferenceWidth =
                Math.max(
                    1,
                    Math.round(
                        tile.width *
                        scale
                    )
                );

            const inferenceHeight =
                Math.max(
                    1,
                    Math.round(
                        tile.height *
                        scale
                    )
                );

            let input =
                tileCanvas;

            if (
                inferenceWidth !==
                    tile.width ||
                inferenceHeight !==
                    tile.height
            ) {
                const resizedCanvas =
                    createCanvas(
                        inferenceWidth,
                        inferenceHeight
                    );

                const ctx =
                    resizedCanvas.getContext(
                        "2d",
                        {
                            willReadFrequently:
                                true
                        }
                    );

                ctx.drawImage(
                    tileCanvas,

                    0,
                    0,

                    inferenceWidth,
                    inferenceHeight
                );

                input =
                    resizedCanvas;
            }

            const predictions =
                await runModel(
                    input
                );

            metrics.rawDetections +=
                predictions.length;

            if (
                passName ===
                "Standard"
            ) {
                metrics.standardRaw +=
                    predictions.length;
            }

            if (
                passName ===
                "Small-face"
            ) {
                metrics.smallRaw +=
                    predictions.length;
            }

            if (
                passName ===
                "Tiny-face"
            ) {
                metrics.tinyRaw +=
                    predictions.length;
            }

            for (
                const prediction
                of predictions
            ) {
                const detection =
                    convertPrediction(
                        prediction,

                        tile.x,
                        tile.y,

                        tile.width,
                        tile.height,

                        inferenceWidth,
                        inferenceHeight,

                        imageWidth,
                        imageHeight
                    );

                if (detection) {
                    detections.push(
                        detection
                    );
                }
            }
        }

        if (
            passName ===
            "Standard"
        ) {
            metrics.standardValidated =
                detections.length;
        }

        if (
            passName ===
            "Small-face"
        ) {
            metrics.smallValidated =
                detections.length;
        }

        if (
            passName ===
            "Tiny-face"
        ) {
            metrics.tinyValidated =
                detections.length;
        }

        console.log(
            `[FACE] ${passName} validated=${detections.length}`
        );

        return detections;
    }

    /* ============================================================
     * IOU
     * ============================================================ */

    function calculateIoU(
        a,
        b
    ) {
        const ax1 = a.x;
        const ay1 = a.y;
        const ax2 =
            a.x + a.width;
        const ay2 =
            a.y + a.height;

        const bx1 = b.x;
        const by1 = b.y;
        const bx2 =
            b.x + b.width;
        const by2 =
            b.y + b.height;

        const x1 =
            Math.max(
                ax1,
                bx1
            );

        const y1 =
            Math.max(
                ay1,
                by1
            );

        const x2 =
            Math.min(
                ax2,
                bx2
            );

        const y2 =
            Math.min(
                ay2,
                by2
            );

        const width =
            Math.max(
                0,
                x2 - x1
            );

        const height =
            Math.max(
                0,
                y2 - y1
            );

        const intersection =
            width * height;

        if (
            intersection <= 0
        ) {
            return 0;
        }

        const areaA =
            a.width *
            a.height;

        const areaB =
            b.width *
            b.height;

        const union =
            areaA +
            areaB -
            intersection;

        return union > 0
            ? intersection / union
            : 0;
    }

    /* ============================================================
     * CENTER
     * ============================================================ */

    function getCenter(
        rect
    ) {
        return {
            x:
                rect.x +
                rect.width / 2,

            y:
                rect.y +
                rect.height / 2
        };
    }

    /* ============================================================
     * SIZE RATIO
     * ============================================================ */

    function getSizeRatio(
        a,
        b
    ) {
        const areaA =
            Math.max(
                1,
                a.width *
                a.height
            );

        const areaB =
            Math.max(
                1,
                b.width *
                b.height
            );

        return (
            Math.max(
                areaA,
                areaB
            ) /
            Math.min(
                areaA,
                areaB
            )
        );
    }

    /* ============================================================
     * DUPLICATE TEST
     * ============================================================ */

    function shouldMergeDetections(
        first,
        second
    ) {
        const iou =
            calculateIoU(
                first.rect,
                second.rect
            );

        if (
            iou >=
            MERGE_IOU_THRESHOLD
        ) {
            return true;
        }

        const a =
            getCenter(
                first.rect
            );

        const b =
            getCenter(
                second.rect
            );

        const dx =
            a.x - b.x;

        const dy =
            a.y - b.y;

        const distance =
            Math.sqrt(
                dx * dx +
                dy * dy
            );

        const minDimension =
            Math.min(
                first.rect.width,
                first.rect.height,
                second.rect.width,
                second.rect.height
            );

        const sizeRatio =
            getSizeRatio(
                first.rect,
                second.rect
            );

        return (
            distance <=
            minDimension *
            DUPLICATE_CENTER_DISTANCE_FACTOR
        ) &&
        (
            sizeRatio <=
            DUPLICATE_SIZE_RATIO
        );
    }

    /* ============================================================
     * MERGE TWO
     * ============================================================ */

    function mergeTwoDetections(
        first,
        second
    ) {
        const totalWeight =
            Math.max(
                0.001,
                first.confidence +
                second.confidence
            );

        const primary =
            first.confidence >=
            second.confidence
                ? first
                : second;

        return {
            ...primary,

            confidence:
                Math.max(
                    first.confidence,
                    second.confidence
                ),

            rect: {
                x:
                    (
                        first.rect.x *
                        first.confidence +
                        second.rect.x *
                        second.confidence
                    ) /
                    totalWeight,

                y:
                    (
                        first.rect.y *
                        first.confidence +
                        second.rect.y *
                        second.confidence
                    ) /
                    totalWeight,

                width:
                    (
                        first.rect.width *
                        first.confidence +
                        second.rect.width *
                        second.confidence
                    ) /
                    totalWeight,

                height:
                    (
                        first.rect.height *
                        first.confidence +
                        second.rect.height *
                        second.confidence
                    ) /
                    totalWeight
            }
        };
    }

    /* ============================================================
     * MERGE DETECTIONS
     * ============================================================ */

    function mergeDetections(
        detections
    ) {
        if (
            !detections ||
            !detections.length
        ) {
            return [];
        }

        const sorted =
            [...detections].sort(
                (a, b) =>
                    b.confidence -
                    a.confidence
            );

        const merged = [];

        for (
            const detection
            of sorted
        ) {
            let mergedExisting =
                false;

            for (
                let i = 0;
                i < merged.length;
                i++
            ) {
                if (
                    shouldMergeDetections(
                        merged[i],
                        detection
                    )
                ) {
                    merged[i] =
                        mergeTwoDetections(
                            merged[i],
                            detection
                        );

                    metrics.duplicateMerged++;

                    mergedExisting =
                        true;

                    break;
                }
            }

            if (
                !mergedExisting
            ) {
                merged.push(
                    {
                        ...detection
                    }
                );
            }
        }

        return merged.map(
            detection => ({
                type:
                    "FACE",

                source:
                    "vision",

                confidence:
                    detection.confidence,

                rect: {
                    x:
                        detection.rect.x,

                    y:
                        detection.rect.y,

                    width:
                        detection.rect.width,

                    height:
                        detection.rect.height
                },

                ...(detection.landmarks?.length
                    ? {
                        landmarks:
                            detection.landmarks
                    }
                    : {})
            })
        );
    }

    /* ============================================================
     * CLAMP
     * ============================================================ */

    function clampDetection(
        detection,
        imageWidth,
        imageHeight
    ) {
        const r =
            detection.rect;

        const x1 =
            Math.max(
                0,
                Math.min(
                    imageWidth,
                    r.x
                )
            );

        const y1 =
            Math.max(
                0,
                Math.min(
                    imageHeight,
                    r.y
                )
            );

        const x2 =
            Math.max(
                0,
                Math.min(
                    imageWidth,
                    r.x + r.width
                )
            );

        const y2 =
            Math.max(
                0,
                Math.min(
                    imageHeight,
                    r.y + r.height
                )
            );

        return {
            ...detection,

            rect: {
                x: x1,
                y: y1,

                width:
                    Math.max(
                        0,
                        x2 - x1
                    ),

                height:
                    Math.max(
                        0,
                        y2 - y1
                    )
            }
        };
    }

    /* ============================================================
     * MAIN DETECTION
     * ============================================================ */

    async function detect(
        source
    ) {
        const startTime =
            performance.now();

        resetMetrics();

        console.log(
            `[FACE] Starting face detection | version=${FACE_VERSION}`
        );

        await ensureDependencies();

        /* --------------------------------------------------------
         * INPUT NORMALIZATION
         * -------------------------------------------------------- */

        const image =
            await normalizeImageSource(
                source
            );

        /* --------------------------------------------------------
         * DIMENSIONS
         * -------------------------------------------------------- */

        const {
            width: imageWidth,
            height: imageHeight
        } =
            getImageDimensions(
                image
            );

        console.log(
            `[FACE] Image dimensions=${imageWidth}x${imageHeight}`
        );

        const allDetections = [];

        /* --------------------------------------------------------
         * FULL IMAGE
         * -------------------------------------------------------- */

        try {
            const detections =
                await detectFullImage(
                    image,
                    imageWidth,
                    imageHeight
                );

            allDetections.push(
                ...detections
            );
        } catch (error) {
            console.warn(
                "[FACE] Full-image detection failed:",
                error
            );
        }

        /* --------------------------------------------------------
         * STANDARD
         * -------------------------------------------------------- */

        try {
            const detections =
                await detectTiles(
                    image,
                    imageWidth,
                    imageHeight,
                    STANDARD_TILE_SIZE,
                    "Standard"
                );

            allDetections.push(
                ...detections
            );
        } catch (error) {
            console.warn(
                "[FACE] Standard detection failed:",
                error
            );
        }

        /* --------------------------------------------------------
         * SMALL
         * -------------------------------------------------------- */

        try {
            const detections =
                await detectTiles(
                    image,
                    imageWidth,
                    imageHeight,
                    SMALL_TILE_SIZE,
                    "Small-face"
                );

            allDetections.push(
                ...detections
            );
        } catch (error) {
            console.warn(
                "[FACE] Small-face detection failed:",
                error
            );
        }

        /* --------------------------------------------------------
         * TINY
         * -------------------------------------------------------- */

        try {
            const detections =
                await detectTiles(
                    image,
                    imageWidth,
                    imageHeight,
                    TINY_TILE_SIZE,
                    "Tiny-face"
                );

            allDetections.push(
                ...detections
            );
        } catch (error) {
            console.warn(
                "[FACE] Tiny-face detection failed:",
                error
            );
        }

        console.log(
            `[FACE] Validated detections before merge=${allDetections.length}`
        );

        /* --------------------------------------------------------
         * MERGE
         * -------------------------------------------------------- */

        const merged =
            mergeDetections(
                allDetections
            );

        /* --------------------------------------------------------
         * CLAMP
         * -------------------------------------------------------- */

        const finalDetections =
            merged
                .map(
                    detection =>
                        clampDetection(
                            detection,
                            imageWidth,
                            imageHeight
                        )
                )
                .filter(
                    detection =>
                        detection.rect.width >
                            0 &&
                        detection.rect.height >
                            0
                );

        const elapsed =
            performance.now() -
            startTime;

        metrics.inferenceTime =
            elapsed;

        metrics.finalFaces =
            finalDetections.length;

        console.log(
            `[FACE] Duplicate detections merged=${metrics.duplicateMerged}`
        );

        console.log(
            `[FACE] Geometry rejected=${metrics.geometryRejected}`
        );

        console.log(
            `[FACE] Landmark rejected=${metrics.landmarkRejected}`
        );

        console.log(
            `[FACE] Final merged faces=${finalDetections.length}`
        );

        console.log(
            `[FACE] Inference: ${elapsed.toFixed(2)} ms | faces=${finalDetections.length}`
        );

        /* --------------------------------------------------------
         * FACE DETAILS
         * -------------------------------------------------------- */

        finalDetections.forEach(
            (
                detection,
                index
            ) => {
                console.log(
                    `[FACE] Face ${index + 1}:`,
                    {
                        confidence:
                            Number(
                                detection.confidence.toFixed(
                                    4
                                )
                            ),

                        x:
                            Number(
                                detection.rect.x.toFixed(
                                    1
                                )
                            ),

                        y:
                            Number(
                                detection.rect.y.toFixed(
                                    1
                                )
                            ),

                        width:
                            Number(
                                detection.rect.width.toFixed(
                                    1
                                )
                            ),

                        height:
                            Number(
                                detection.rect.height.toFixed(
                                    1
                                )
                            )
                    }
                );
            }
        );

        return finalDetections;
    }

    /* ============================================================
     * METRICS
     * ============================================================ */

    function getMetrics() {
        return {
            ...metrics
        };
    }

    function resetMetrics() {
        metrics.inferenceTime = 0;

        metrics.rawDetections = 0;

        metrics.standardRaw = 0;
        metrics.standardValidated = 0;

        metrics.smallRaw = 0;
        metrics.smallValidated = 0;

        metrics.tinyRaw = 0;
        metrics.tinyValidated = 0;

        metrics.geometryRejected = 0;

        metrics.landmarkRejected = 0;

        metrics.duplicateMerged = 0;

        metrics.finalFaces = 0;
    }

    /* ============================================================
     * PUBLIC API
     * ============================================================ */

    window.SIHFace = {
        version:
            FACE_VERSION,

        init:
            ensureDependencies,

        detect,

        getMetrics,

        resetMetrics,

        config: {
            FACE_CONFIDENCE_THRESHOLD,

            MAX_INFERENCE_DIMENSION,

            STANDARD_TILE_SIZE,
            SMALL_TILE_SIZE,
            TINY_TILE_SIZE,

            TILE_OVERLAP,

            MIN_FACE_SIZE,
            MIN_VALID_FACE_SIZE,

            MIN_FACE_ASPECT_RATIO,
            MAX_FACE_ASPECT_RATIO,

            MAX_SCREEN_FACE_RATIO,

            MERGE_IOU_THRESHOLD,
            DUPLICATE_CENTER_DISTANCE_FACTOR,
            DUPLICATE_SIZE_RATIO
        }
    };

    console.log(
        `[FACE] SIH Face module loaded | version=${FACE_VERSION}`
    );

})();