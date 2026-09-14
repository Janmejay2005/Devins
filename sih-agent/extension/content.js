console.log(" SIH Privacy Agent loaded");

function detectDOMPII() {
    const detections = [];

    const elements = document.querySelectorAll(
        "input, textarea, select"
    );

    elements.forEach((element, index) => {

        const type = (
            element.getAttribute("type") || ""
        ).toLowerCase();

        const autocomplete = (
            element.getAttribute("autocomplete") || ""
        ).toLowerCase();

        const name = (
            element.getAttribute("name") || ""
        ).toLowerCase();

        const id = (
            element.getAttribute("id") || ""
        ).toLowerCase();

        let piiType = null;
        let confidence = 0;

        // PASSWORD
        if (type === "password") {
            piiType = "PASSWORD";
            confidence = 1.0;
        }

        // EMAIL
        else if (
            type === "email" ||
            autocomplete.includes("email") ||
            name.includes("email") ||
            id.includes("email")
        ) {
            piiType = "EMAIL";
            confidence = 0.95;
        }

        // PHONE
        else if (
            type === "tel" ||
            autocomplete.includes("tel") ||
            name.includes("phone") ||
            name.includes("mobile") ||
            id.includes("phone") ||
            id.includes("mobile")
        ) {
            piiType = "PHONE";
            confidence = 0.95;
        }

        // CREDIT CARD
        else if (
            autocomplete.includes("cc-number") ||
            name.includes("card") ||
            id.includes("card")
        ) {
            piiType = "CARD";
            confidence = 0.95;
        }

        if (piiType) {

            const rect = element.getBoundingClientRect();

            detections.push({
                type: piiType,
                confidence: confidence,

                element: {
                    tag: element.tagName,
                    id: element.id,
                    name: element.getAttribute("name"),
                    type: type
                },

                boundingBox: {
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            });
        }
    });

    return detections;
}


// Run detector
const detections = detectDOMPII();

console.log(
    "🔍 Local PII detections:",
    detections
);