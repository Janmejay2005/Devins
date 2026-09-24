// ============================================================
// SIH PRIVACY BROWSER AGENT
// ============================================================
// fusion.js
// Phase 2.4 — Multi-Source PII Fusion
//
// Purpose:
// Combine DOM + OCR detections into one unified local PII set.
//
// SECURITY:
// - No PII values are stored here.
// - No OCR text is transmitted.
// - Only detection metadata and geometry are used.
// ============================================================

(function () {

    "use strict";


    const FUSION_VERSION = "2.4.0";


    // ========================================================
    // CONFIGURATION
    // ========================================================

    const CONFIG = {

        // Minimum IoU required for two detections
        // to be considered overlapping.
        iouThreshold: 0.30,

        // Center-distance fallback.
        // Used when boxes are close but IoU is weak.
        centerDistanceRatio: 0.50,

        // Maximum confidence value.
        maxConfidence: 1,

        // Source priority when confidence is equal.
        sourcePriority: {
            dom: 3,
            ocr: 2,
            vision: 1
        }

    };


    // ========================================================
    // VALIDATE RECT
    // ========================================================

    function isValidRect(rect) {

        if (!rect || typeof rect !== "object") {
            return false;
        }

        const values = [
            rect.left,
            rect.top,
            rect.right,
            rect.bottom
        ];

        if (
            values.some(
                value => !Number.isFinite(Number(value))
            )
        ) {
            return false;
        }

        return (
            Number(rect.right) > Number(rect.left) &&
            Number(rect.bottom) > Number(rect.top)
        );
    }


    // ========================================================
    // NORMALIZE RECT
    // ========================================================

    function normalizeRect(rect) {

        if (!isValidRect(rect)) {
            return null;
        }

        const left = Number(rect.left);
        const top = Number(rect.top);
        const right = Number(rect.right);
        const bottom = Number(rect.bottom);

        return {

            left,
            top,
            right,
            bottom,

            width:
                right - left,

            height:
                bottom - top
        };
    }


    // ========================================================
    // AREA
    // ========================================================

    function rectArea(rect) {

        if (!isValidRect(rect)) {
            return 0;
        }

        return (
            Math.max(
                0,
                Number(rect.right) -
                Number(rect.left)
            ) *
            Math.max(
                0,
                Number(rect.bottom) -
                Number(rect.top)
            )
        );
    }


    // ========================================================
    // INTERSECTION AREA
    // ========================================================

    function intersectionArea(rectA, rectB) {

        if (
            !isValidRect(rectA) ||
            !isValidRect(rectB)
        ) {
            return 0;
        }

        const left =
            Math.max(
                Number(rectA.left),
                Number(rectB.left)
            );

        const top =
            Math.max(
                Number(rectA.top),
                Number(rectB.top)
            );

        const right =
            Math.min(
                Number(rectA.right),
                Number(rectB.right)
            );

        const bottom =
            Math.min(
                Number(rectA.bottom),
                Number(rectB.bottom)
            );

        if (
            right <= left ||
            bottom <= top
        ) {
            return 0;
        }

        return (
            (right - left) *
            (bottom - top)
        );
    }


    // ========================================================
    // IoU
    // ========================================================

    function calculateIoU(rectA, rectB) {

        const intersection =
            intersectionArea(
                rectA,
                rectB
            );

        if (intersection <= 0) {
            return 0;
        }

        const areaA =
            rectArea(rectA);

        const areaB =
            rectArea(rectB);

        const union =
            areaA +
            areaB -
            intersection;

        if (union <= 0) {
            return 0;
        }

        return intersection / union;
    }


    // ========================================================
    // CENTER DISTANCE
    // ========================================================

    function centerPoint(rect) {

        return {

            x:
                (
                    Number(rect.left) +
                    Number(rect.right)
                ) / 2,

            y:
                (
                    Number(rect.top) +
                    Number(rect.bottom)
                ) / 2
        };
    }


    function centerDistance(rectA, rectB) {

        const centerA =
            centerPoint(rectA);

        const centerB =
            centerPoint(rectB);

        const dx =
            centerA.x -
            centerB.x;

        const dy =
            centerA.y -
            centerB.y;

        return Math.sqrt(
            dx * dx +
            dy * dy
        );
    }


    // ========================================================
    // CENTER DISTANCE THRESHOLD
    // ========================================================

    function centerDistanceThreshold(
        rectA,
        rectB
    ) {

        const width =
            Math.max(
                Number(rectA.width),
                Number(rectB.width)
            );

        const height =
            Math.max(
                Number(rectA.height),
                Number(rectB.height)
            );

        return (
            Math.max(
                width,
                height
            ) *
            CONFIG.centerDistanceRatio
        );
    }


    // ========================================================
    // TYPE COMPATIBILITY
    // ========================================================

    function areTypesCompatible(
        detectionA,
        detectionB
    ) {

        const typeA =
            String(
                detectionA?.type || ""
            ).toUpperCase();

        const typeB =
            String(
                detectionB?.type || ""
            ).toUpperCase();

        if (!typeA || !typeB) {
            return false;
        }

        // Same PII type = directly compatible.
        if (typeA === typeB) {
            return true;
        }

        // Do not merge unrelated PII classes.
        return false;
    }


    // ========================================================
    // DETECTIONS MATCH?
    // ========================================================

    function detectionsMatch(
        detectionA,
        detectionB
    ) {

        if (
            !detectionA ||
            !detectionB
        ) {
            return false;
        }

        if (
            !areTypesCompatible(
                detectionA,
                detectionB
            )
        ) {
            return false;
        }

        const rectA =
            normalizeRect(
                detectionA.rect
            );

        const rectB =
            normalizeRect(
                detectionB.rect
            );

        if (!rectA || !rectB) {
            return false;
        }

        const iou =
            calculateIoU(
                rectA,
                rectB
            );

        if (
            iou >=
            CONFIG.iouThreshold
        ) {
            return true;
        }

        // IoU can be weak when OCR and DOM
        // produce differently sized boxes.
        const distance =
            centerDistance(
                rectA,
                rectB
            );

        const threshold =
            centerDistanceThreshold(
                rectA,
                rectB
            );

        return (
            distance <= threshold
        );
    }


    // ========================================================
    // CONFIDENCE
    // ========================================================

    function normalizeConfidence(
        detection
    ) {

        const confidence =
            Number(
                detection?.confidence
            );

        if (
            !Number.isFinite(
                confidence
            )
        ) {
            return 0;
        }

        return Math.max(
            0,
            Math.min(
                CONFIG.maxConfidence,
                confidence
            )
        );
    }


    // ========================================================
    // SOURCE PRIORITY
    // ========================================================

    function getSourcePriority(
        source
    ) {

        return (
            CONFIG.sourcePriority[
                String(
                    source || ""
                ).toLowerCase()
            ] || 0
        );
    }


    // ========================================================
    // MERGE RECTANGLES
    // ========================================================

    function mergeRectangles(
        rectA,
        rectB
    ) {

        const a =
            normalizeRect(rectA);

        const b =
            normalizeRect(rectB);

        if (!a) {
            return b;
        }

        if (!b) {
            return a;
        }

        const left =
            Math.min(
                a.left,
                b.left
            );

        const top =
            Math.min(
                a.top,
                b.top
            );

        const right =
            Math.max(
                a.right,
                b.right
            );

        const bottom =
            Math.max(
                a.bottom,
                b.bottom
            );

        return {

            left,
            top,
            right,
            bottom,

            width:
                right - left,

            height:
                bottom - top
        };
    }


    // ========================================================
    // MERGE TWO DETECTIONS
    // ========================================================

    function mergeDetections(
        detectionA,
        detectionB
    ) {

        const confidenceA =
            normalizeConfidence(
                detectionA
            );

        const confidenceB =
            normalizeConfidence(
                detectionB
            );

        const priorityA =
            getSourcePriority(
                detectionA.source
            );

        const priorityB =
            getSourcePriority(
                detectionB.source
            );

        let primary =
            detectionA;

        if (
            confidenceB >
            confidenceA
        ) {

            primary =
                detectionB;

        } else if (
            confidenceB ===
            confidenceA &&
            priorityB >
            priorityA
        ) {

            primary =
                detectionB;
        }

        return {

            type:
                String(
                    primary.type
                ).toUpperCase(),

            source:
                detectionA.source ===
                detectionB.source
                    ? detectionA.source
                    : "fused",

            confidence:
                Math.max(
                    confidenceA,
                    confidenceB
                ),

            rect:
                mergeRectangles(
                    detectionA.rect,
                    detectionB.rect
                ),

            sources:
                Array.from(
                    new Set([
                        detectionA.source,
                        detectionB.source
                    ])
                )
        };
    }


    // ========================================================
    // FUSE DETECTIONS
    // ========================================================

    function fuseDetections(
        detections
    ) {

        const start =
            performance.now();

        if (
            !Array.isArray(
                detections
            )
        ) {

            return {

                detections: [],

                stats: {

                    input: 0,
                    output: 0,
                    merged: 0,
                    dom: 0,
                    ocr: 0,
                    fused: 0
                },

                latencyMs:
                    0
            };
        }


        const validDetections =
            detections
                .filter(
                    detection =>
                        detection &&
                        isValidRect(
                            detection.rect
                        )
                )
                .map(
                    detection => ({

                        type:
                            String(
                                detection.type ||
                                ""
                            ).toUpperCase(),

                        source:
                            String(
                                detection.source ||
                                "unknown"
                            ).toLowerCase(),

                        confidence:
                            normalizeConfidence(
                                detection
                            ),

                        rect:
                            normalizeRect(
                                detection.rect
                            )
                    })
                )
                .filter(
                    detection =>
                        detection.type &&
                        detection.rect
                );


        const fused = [];

        let mergedCount = 0;


        for (
            const detection
            of validDetections
        ) {

            let merged = false;


            for (
                let i = 0;
                i < fused.length;
                i++
            ) {

                const existing =
                    fused[i];


                if (
                    detectionsMatch(
                        existing,
                        detection
                    )
                ) {

                    fused[i] =
                        mergeDetections(
                            existing,
                            detection
                        );

                    mergedCount++;

                    merged = true;

                    break;
                }
            }


            if (!merged) {

                fused.push({

                    type:
                        detection.type,

                    source:
                        detection.source,

                    confidence:
                        detection.confidence,

                    rect:
                        detection.rect,

                    sources:
                        [
                            detection.source
                        ]
                });
            }
        }


        const stats = {

            input:
                validDetections.length,

            output:
                fused.length,

            merged:
                mergedCount,

            dom:
                validDetections.filter(
                    detection =>
                        detection.source === "dom"
                ).length,

            ocr:
                validDetections.filter(
                    detection =>
                        detection.source === "ocr"
                ).length,

            fused:
                fused.filter(
                    detection =>
                        detection.source === "fused"
                ).length
        };


        const latencyMs =
            performance.now() -
            start;


        console.log(
            "[FUSION] Multi-source PII fusion:",
            `input=${stats.input}`,
            `output=${stats.output}`,
            `merged=${stats.merged}`,
            `dom=${stats.dom}`,
            `ocr=${stats.ocr}`,
            `fused=${stats.fused}`,
            `latency=${latencyMs.toFixed(2)} ms`
        );


        return {

            detections:
                fused,

            stats,

            latencyMs
        };
    }


    // ========================================================
    // SAFE SERIALIZATION
    // ========================================================

    function serialize(
        detections
    ) {

        if (
            !Array.isArray(
                detections
            )
        ) {
            return [];
        }

        return detections.map(
            detection => ({

                type:
                    detection.type,

                source:
                    detection.source,

                confidence:
                    Number(
                        detection.confidence
                    ),

                sources:
                    Array.isArray(
                        detection.sources
                    )
                        ? [
                            ...detection.sources
                        ]
                        : [],

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


    // ========================================================
    // PUBLIC API
    // ========================================================

    window.SIHPiiFusion = {

        version:
            FUSION_VERSION,

        fuse:
            fuseDetections,

        serialize,

        calculateIoU,

        detectionsMatch

    };


    console.log(
        "[FUSION] PII Fusion module loaded:",
        FUSION_VERSION
    );

})();