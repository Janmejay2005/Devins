# Browser Compatibility

| Browser | Engine | Status | Notes |
| --- | --- | --- | --- |
| Chrome | Chromium | Not Tested | Dedicated Manifest V3 service-worker build is packaged; browser runtime smoke test remains outstanding. |
| Edge | Chromium | Not Tested | Uses the Chromium package; browser runtime smoke test remains outstanding. |
| Brave | Chromium | Not Tested | Uses the Chromium package; browser runtime smoke test remains outstanding. |
| Firefox | Gecko | Not Tested | Original manifest and Firefox bridge were left unchanged; this Chromium package is not the Firefox build. |

Static package checks validate JSON parsing, required packaged paths, the MV3 service-worker entry, and JavaScript syntax. They do not substitute for loading the extension in each browser. The existing OCR initialization relies on Tesseract.js default worker/core/language resolution, and BlazeFace uses its default model source; those paths can require external network access and still need browser-level verification under the target browser's CSP and worker rules.