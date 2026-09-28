// ============================================================
// SIH PRIVACY BROWSER AGENT
// fusion.js
// Phase 4 — Multi-Source PII Fusion
// Version 4.0.3
// ============================================================

(function () {

    "use strict";

    const FUSION_VERSION = "4.0.3";


    // ========================================================
    // CONFIGURATION
    // ========================================================

    const CONFIG = {

        iouThreshold: 0.30,

        centerDistanceRatio: 0.50,

        maxConfidence: 1,

        fusedConfidenceCap: 0.999,

        conflictPolicy: "preserve_all",

        // Phase 4.5
        // Higher number = higher PII priority.
        typePriority: {

            credential: 5,

            aadhaarPanCard: 4,

            contact: 3,

            face: 2,

            other: 1
        },

        sourcePriority: {

            dom: 3,

            ocr: 2,

            face: 1,

            vision: 1
        }
    };


    // ========================================================
    // RECT HELPERS
    // ========================================================

    function isValidRect(rect) {

        if (!rect || typeof rect !== "object") {
            return false;
        }

        const left = Number(rect.left);
        const top = Number(rect.top);
        const right = Number(rect.right);
        const bottom = Number(rect.bottom);

        return (
            Number.isFinite(left) &&
            Number.isFinite(top) &&
            Number.isFinite(right) &&
            Number.isFinite(bottom) &&
            right > left &&
            bottom > top
        );
    }


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
            width: right - left,
            height: bottom - top
        };
    }


    function rectArea(rect) {

        const r = normalizeRect(rect);

        if (!r) {
            return 0;
        }

        return r.width * r.height;
    }


    function intersectionArea(rectA, rectB) {

        const a = normalizeRect(rectA);
        const b = normalizeRect(rectB);

        if (!a || !b) {
            return 0;
        }

        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        const right = Math.min(a.right, b.right);
        const bottom = Math.min(a.bottom, b.bottom);

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


    function calculateIoU(rectA, rectB) {

        const intersection =
            intersectionArea(
                rectA,
                rectB
            );

        if (intersection <= 0) {
            return 0;
        }

        const union =
            rectArea(rectA) +
            rectArea(rectB) -
            intersection;

        if (union <= 0) {
            return 0;
        }

        return intersection / union;
    }


    function centerPoint(rect) {

        return {
            x: (
                Number(rect.left) +
                Number(rect.right)
            ) / 2,

            y: (
                Number(rect.top) +
                Number(rect.bottom)
            ) / 2
        };
    }


    function centerDistance(rectA, rectB) {

        const a = centerPoint(rectA);
        const b = centerPoint(rectB);

        const dx = a.x - b.x;
        const dy = a.y - b.y;

        return Math.sqrt(
            dx * dx +
            dy * dy
        );
    }


    function centerDistanceThreshold(rectA, rectB) {

        const a = normalizeRect(rectA);
        const b = normalizeRect(rectB);

        if (!a || !b) {
            return 0;
        }

        return (
            Math.max(
                a.width,
                b.width,
                a.height,
                b.height
            ) *
            CONFIG.centerDistanceRatio
        );
    }


    // ========================================================
    // NORMALIZATION
    // ========================================================

    function normalizeType(type) {

        return String(type || "")
            .trim()
            .toUpperCase();
    }


    function normalizeSource(source, type) {

        const normalizedType =
            String(type || "")
                .trim()
                .toLowerCase();

        const normalizedSource =
            String(source || "")
                .trim()
                .toLowerCase();

        if (
            normalizedType === "face" &&
            (
                normalizedSource === "vision" ||
                normalizedSource === "face" ||
                normalizedSource === ""
            )
        ) {
            return "face";
        }

        if (
            normalizedSource === "dom" ||
            normalizedSource === "ocr" ||
            normalizedSource === "face" ||
            normalizedSource === "vision"
        ) {
            return normalizedSource;
        }

        return "unknown";
    }


    // ========================================================
    // PHASE 4.5 — TYPE PRIORITY
    // ========================================================

    function getTypePriority(type) {

        const normalizedType =
            normalizeType(type);

        if (
            normalizedType.includes("PASSWORD") ||
            normalizedType.includes("PASSCODE") ||
            normalizedType.includes("CREDENTIAL") ||
            normalizedType.includes("SECRET")
        ) {
            return {
                rank: CONFIG.typePriority.credential,
                label: "credential"
            };
        }

        if (
            normalizedType.includes("AADHAAR") ||
            normalizedType.includes("PAN") ||
            normalizedType.includes("CARD") ||
            normalizedType.includes("CREDIT") ||
            normalizedType.includes("DEBIT")
        ) {
            return {
                rank: CONFIG.typePriority.aadhaarPanCard,
                label: "aadhaar-pan-card"
            };
        }

        if (
            normalizedType.includes("EMAIL") ||
            normalizedType.includes("PHONE") ||
            normalizedType.includes("MOBILE") ||
            normalizedType.includes("TEL")
        ) {
            return {
                rank: CONFIG.typePriority.contact,
                label: "contact"
            };
        }

        if (
            normalizedType === "FACE"
        ) {
            return {
                rank: CONFIG.typePriority.face,
                label: "face"
            };
        }

        return {
            rank: CONFIG.typePriority.other,
            label: "other"
        };
    }


    function getDetectionPriority(
        detection
    ) {

        return getTypePriority(
            detection?.type
        );
    }


    function getSourcePriority(source) {

        return (
            CONFIG.sourcePriority[
                String(
                    source || ""
                ).toLowerCase()
            ] || 0
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
            normalizeType(
                detectionA?.type
            );

        const typeB =
            normalizeType(
                detectionB?.type
            );

        if (!typeA || !typeB) {
            return false;
        }

        // Same PII type can be fused.
        if (typeA === typeB) {
            return true;
        }

        // FACE never merges with text PII.
        if (
            typeA === "FACE" ||
            typeB === "FACE"
        ) {
            return false;
        }

        // Different PII classes remain separate.
        return false;
    }


    // ========================================================
    // DETECTION MATCH
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

        return (
            centerDistance(
                rectA,
                rectB
            ) <=
            centerDistanceThreshold(
                rectA,
                rectB
            )
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


    function combineConfidence(
        confidenceA,
        confidenceB
    ) {

        const a = Math.max(
            0,
            Math.min(
                CONFIG.maxConfidence,
                Number(confidenceA) || 0
            )
        );

        const b = Math.max(
            0,
            Math.min(
                CONFIG.maxConfidence,
                Number(confidenceB) || 0
            )
        );

        return Math.min(
            CONFIG.fusedConfidenceCap,
            1 - (
                (1 - a) *
                (1 - b)
            )
        );
    }


    // ========================================================
    // OCR REDACTION ELIGIBILITY
    // ========================================================

    function isRedactionEligible(
        detection
    ) {

        if (!detection) {
            return false;
        }

        const source =
            String(
                detection.source || ""
            ).toLowerCase();

        if (source !== "ocr") {
            return true;
        }

        if (
            detection.redactionRecommended ===
            false
        ) {
            return false;
        }

        return true;
    }


    // ========================================================
    // RECTANGLE MERGE
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
            width: right - left,
            height: bottom - top
        };
    }


    // ========================================================
    // NORMALIZE DETECTION
    // ========================================================

    function normalizeDetection(
        detection
    ) {

        if (!detection) {
            return null;
        }

        const type =
            normalizeType(
                detection.type
            );

        const source =
            normalizeSource(
                detection.source,
                detection.type
            );

        const rect =
            normalizeRect(
                detection.rect
            );

        if (
            !type ||
            !rect
        ) {
            return null;
        }

        const priority =
            getTypePriority(type);

        return {

            type,

            source,

            confidence:
                normalizeConfidence(
                    detection
                ),

            uncertain:
                Boolean(
                    detection.uncertain
                ),

            redactionRecommended:
                isRedactionEligible({
                    ...detection,
                    source
                }),

            rect,

            priorityRank:
                priority.rank,

            priorityLabel:
                priority.label,

            sources: [
                source
            ],

            evidenceCount: 1,

            conflict: false,

            conflictPrimary: false
        };
    }


    // ========================================================
    // MERGE TWO SAME-TYPE DETECTIONS
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

        const sourcePriorityA =
            getSourcePriority(
                detectionA.source
            );

        const sourcePriorityB =
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
            sourcePriorityB >
            sourcePriorityA
        ) {

            primary =
                detectionB;
        }

        const sources =
            Array.from(
                new Set([
                    ...(Array.isArray(
                        detectionA.sources
                    )
                        ? detectionA.sources
                        : [detectionA.source]),

                    ...(Array.isArray(
                        detectionB.sources
                    )
                        ? detectionB.sources
                        : [detectionB.source])
                ])
            );

        const evidenceCount =
            Number(
                detectionA.evidenceCount || 1
            ) +
            Number(
                detectionB.evidenceCount || 1
            );

        const priority =
            getTypePriority(
                primary.type
            );

        return {

            type:
                normalizeType(
                    primary.type
                ),

            source:
                sources.length > 1
                    ? "fused"
                    : sources[0],

            confidence:
                sources.length > 1
                    ? combineConfidence(
                        confidenceA,
                        confidenceB
                    )
                    : Math.max(
                        confidenceA,
                        confidenceB
                    ),

            uncertain:
                Boolean(
                    detectionA.uncertain &&
                    detectionB.uncertain
                ),

            redactionRecommended:
                (
                    detectionA.redactionRecommended !== false ||
                    detectionB.redactionRecommended !== false
                ),

            priorityRank:
                priority.rank,

            priorityLabel:
                priority.label,

            conflict:
                Boolean(
                    detectionA.conflict ||
                    detectionB.conflict
                ),

            conflictPrimary:
                Boolean(
                    detectionA.conflictPrimary ||
                    detectionB.conflictPrimary
                ),

            rect:
                mergeRectangles(
                    detectionA.rect,
                    detectionB.rect
                ),

            sources,

            evidenceCount
        };
    }


    // ========================================================
    // FUSION
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
                    face: 0,
                    vision: 0,
                    fused: 0,
                    conflicts: 0,
                    uncertainOCR: 0,
                    evidence: 0,
                    conflictPolicy:
                        CONFIG.conflictPolicy
                },

                latencyMs: 0
            };
        }


        // ----------------------------------------------------
        // NORMALIZE
        // ----------------------------------------------------

        const normalizedDetections =
            detections
                .map(
                    normalizeDetection
                )
                .filter(
                    Boolean
                );


        // ----------------------------------------------------
        // UNCERTAIN OCR
        // ----------------------------------------------------

        const uncertainOCRDetections =
            normalizedDetections.filter(
                function (detection) {

                    return (
                        detection.source === "ocr" &&
                        detection.redactionRecommended === false
                    );
                }
            );


        const redactionEligibleDetections =
            normalizedDetections.filter(
                function (detection) {

                    return (
                        detection.redactionRecommended !== false
                    );
                }
            );


        // ----------------------------------------------------
        // SAME-TYPE MERGE
        // ----------------------------------------------------

        const fused = [];

        let mergeCount = 0;


        for (
            const detection
            of redactionEligibleDetections
        ) {

            let merged = false;


            for (
                let index = 0;
                index < fused.length;
                index++
            ) {

                const existing =
                    fused[index];

                if (
                    detectionsMatch(
                        existing,
                        detection
                    )
                ) {

                    fused[index] =
                        mergeDetections(
                            existing,
                            detection
                        );

                    mergeCount++;

                    merged = true;

                    break;
                }
            }


            if (!merged) {

                const priority =
                    getTypePriority(
                        detection.type
                    );

                fused.push({

                    type:
                        detection.type,

                    source:
                        detection.source,

                    confidence:
                        detection.confidence,

                    uncertain:
                        detection.uncertain,

                    redactionRecommended:
                        detection.redactionRecommended,

                    priorityRank:
                        priority.rank,

                    priorityLabel:
                        priority.label,

                    conflict: false,

                    conflictPrimary: false,

                    rect:
                        detection.rect,

                    sources:
                        [
                            detection.source
                        ],

                    evidenceCount: 1
                });
            }
        }


        // ----------------------------------------------------
        // PHASE 4.4 + 4.5
        // CONFLICT DETECTION + PRIORITY
        // ----------------------------------------------------
        //
        // Safety rule:
        //
        // Conflicting PII types are NEVER discarded.
        //
        // Priority only determines which detection is the
        // primary classification of the conflict.
        //
        // All conflicting detections remain available for
        // redaction.
        // ----------------------------------------------------

        let conflictCount = 0;


        for (
            let i = 0;
            i < normalizedDetections.length;
            i++
        ) {

            for (
                let j = i + 1;
                j < normalizedDetections.length;
                j++
            ) {

                const a =
                    normalizedDetections[i];

                const b =
                    normalizedDetections[j];


                if (
                    !a.rect ||
                    !b.rect
                ) {
                    continue;
                }


                const typeA =
                    normalizeType(
                        a.type
                    );

                const typeB =
                    normalizeType(
                        b.type
                    );


                if (
                    typeA === typeB
                ) {
                    continue;
                }


                const overlap =
                    calculateIoU(
                        a.rect,
                        b.rect
                    );


                if (
                    overlap <
                    CONFIG.iouThreshold
                ) {
                    continue;
                }


                conflictCount++;


                const priorityA =
                    getTypePriority(
                        typeA
                    );

                const priorityB =
                    getTypePriority(
                        typeB
                    );


                let primaryType;


                if (
                    priorityA.rank >
                    priorityB.rank
                ) {

                    primaryType =
                        typeA;

                } else if (
                    priorityB.rank >
                    priorityA.rank
                ) {

                    primaryType =
                        typeB;

                } else {

                    // Equal priority:
                    // higher confidence becomes primary.
                    primaryType =
                        normalizeConfidence(a) >=
                        normalizeConfidence(b)
                            ? typeA
                            : typeB;
                }


                // Mark the unified detections.
                for (
                    const unified
                    of fused
                ) {

                    const unifiedType =
                        normalizeType(
                            unified.type
                        );


                    if (
                        unifiedType !== typeA &&
                        unifiedType !== typeB
                    ) {
                        continue;
                    }


                    const overlapA =
                        calculateIoU(
                            unified.rect,
                            a.rect
                        );

                    const overlapB =
                        calculateIoU(
                            unified.rect,
                            b.rect
                        );


                    if (
                        unifiedType === typeA &&
                        overlapA >=
                        CONFIG.iouThreshold
                    ) {

                        unified.conflict = true;

                        if (
                            typeA ===
                            primaryType
                        ) {
                            unified.conflictPrimary = true;
                        }
                    }


                    if (
                        unifiedType === typeB &&
                        overlapB >=
                        CONFIG.iouThreshold
                    ) {

                        unified.conflict = true;

                        if (
                            typeB ===
                            primaryType
                        ) {
                            unified.conflictPrimary = true;
                        }
                    }
                }
            }
        }


        // ----------------------------------------------------
        // SOURCE STATISTICS
        // ----------------------------------------------------

        const sourceStats = {

            dom: 0,

            ocr: 0,

            face: 0,

            vision: 0
        };


        normalizedDetections.forEach(
            function (detection) {

                const source =
                    String(
                        detection.source || ""
                    ).toLowerCase();


                if (source === "dom") {
                    sourceStats.dom++;
                }

                else if (source === "ocr") {
                    sourceStats.ocr++;
                }

                else if (source === "face") {
                    sourceStats.face++;
                }

                else if (source === "vision") {
                    sourceStats.vision++;
                }
            }
        );


        // ----------------------------------------------------
        // FUSED COUNT
        // ----------------------------------------------------

        const fusedCount =
            fused.filter(
                function (detection) {

                    return (
                        detection.source ===
                        "fused"
                    );
                }
            ).length;


        // ----------------------------------------------------
        // EVIDENCE COUNT
        // ----------------------------------------------------

        const evidence =
            fused.reduce(
                function (
                    sum,
                    detection
                ) {

                    return (
                        sum +
                        Number(
                            detection.evidenceCount ||
                            1
                        )
                    );
                },
                0
            );


        // ----------------------------------------------------
        // PRIORITY STATISTICS
        // ----------------------------------------------------

        const priorityStats = {

            credential: 0,

            aadhaarPanCard: 0,

            contact: 0,

            face: 0,

            other: 0
        };


        fused.forEach(
            function (detection) {

                const priority =
                    getTypePriority(
                        detection.type
                    );

                if (
                    priority.label ===
                    "credential"
                ) {
                    priorityStats.credential++;
                }

                else if (
                    priority.label ===
                    "aadhaar-pan-card"
                ) {
                    priorityStats.aadhaarPanCard++;
                }

                else if (
                    priority.label ===
                    "contact"
                ) {
                    priorityStats.contact++;
                }

                else if (
                    priority.label ===
                    "face"
                ) {
                    priorityStats.face++;
                }

                else {
                    priorityStats.other++;
                }
            }
        );


        // ----------------------------------------------------
        // FINAL STATS
        // ----------------------------------------------------

        const latencyMs =
            performance.now() -
            start;


        const stats = {

            input:
                normalizedDetections.length,

            output:
                fused.length,

            merged:
                mergeCount,

            dom:
                sourceStats.dom,

            ocr:
                sourceStats.ocr,

            face:
                sourceStats.face,

            vision:
                sourceStats.vision,

            fused:
                fusedCount,

            conflicts:
                conflictCount,

            conflictPolicy:
                CONFIG.conflictPolicy,

            uncertainOCR:
                uncertainOCRDetections.length,

            evidence,

            priority:
                priorityStats,

            latencyMs
        };


        console.log(
            "[FUSION] Multi-source PII fusion:",
            `input=${stats.input}`,
            `output=${stats.output}`,
            `merged=${stats.merged}`,
            `dom=${stats.dom}`,
            `ocr=${stats.ocr}`,
            `face=${stats.face}`,
            `fused=${stats.fused}`,
            `conflicts=${stats.conflicts}`,
            `conflictPolicy=${stats.conflictPolicy}`,
            `uncertainOCR=${stats.uncertainOCR}`,
            `evidence=${stats.evidence}`,
            `latency=${stats.latencyMs.toFixed(2)} ms`
        );


        return {

            detections:
                fused,

            stats,

            latencyMs
        };
    }


    // ========================================================
    // SERIALIZATION
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
            function (detection) {

                const priority =
                    getTypePriority(
                        detection.type
                    );


                return {

                    type:
                        detection.type,

                    source:
                        detection.source,

                    confidence:
                        Number(
                            detection.confidence
                        ),

                    uncertain:
                        Boolean(
                            detection.uncertain
                        ),

                    priorityRank:
                        Number(
                            detection.priorityRank ||
                            priority.rank
                        ),

                    priorityLabel:
                        detection.priorityLabel ||
                        priority.label,

                    conflict:
                        Boolean(
                            detection.conflict
                        ),

                    conflictPrimary:
                        Boolean(
                            detection.conflictPrimary
                        ),

                    redactionRecommended:
                        detection.redactionRecommended !==
                        false,

                    sources:
                        Array.isArray(
                            detection.sources
                        )
                            ? [
                                ...detection.sources
                            ]
                            : [],

                    evidenceCount:
                        Number(
                            detection.evidenceCount ||
                            1
                        ),

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
                };
            }
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