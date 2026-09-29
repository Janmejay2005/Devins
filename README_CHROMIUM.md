# DEVINS Chromium Build

This build uses the existing extension scripts and assets. The Firefox source manifest at `sih-agent/extension/manifest.json` is unchanged; the Chromium-specific source manifest is `sih-agent/extension/manifest.chromium.json`.

## Build

From the repository root in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-chromium.ps1
```

This creates `dist/devins-chromium/` for **Load unpacked** and `devins-chromium.zip` for transfer. To rebuild and replace those generated outputs, add `-Force`.

The package includes only the manifest, required extension scripts, ML libraries already in the project, worker script, and manifest icons. It excludes the backend, test pages, package metadata, virtual environment, and development files.

## Install

1. Open `chrome://extensions` in Chrome, `edge://extensions` in Microsoft Edge, or `brave://extensions` in Brave.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose the repository's `dist/devins-chromium` folder.
4. Pin DEVINS if desired, open a regular HTTP or HTTPS page, and select the extension icon.

To reload after rebuilding, select the extension's **Reload** control on the extensions page. To remove it, select **Remove** there. Chromium browsers cannot inject content scripts into internal browser pages, extension stores, or some protected pages; use an ordinary HTTP/HTTPS page for the demo.

## Inspect Errors

- On the extensions page, use the extension's **Errors** control for manifest and load errors.
- Select **service worker** under the extension's Inspect views to inspect `background.js` logs and API failures.
- Open the popup and inspect it with the popup's browser developer tools.
- On a test page, use that page's developer tools Console to inspect content-script, OCR, face-detection, and privacy-pipeline logs.
- A page opened before installation or reload may need a refresh before its content scripts are injected.

## Test the Privacy Pipeline

1. Serve the supplied test pages over HTTP so the extension can inject its content scripts:

   ```powershell
   python -m http.server 8001 --directory .\sih-agent\test-pages
   ```

2. Visit `http://127.0.0.1:8001/government-form.html` or another supplied test page. Use only synthetic test data.
3. Open DEVINS and run a task. Confirm the popup reports a successful local capture/sanitization and inspect its privacy audit and sanitized preview.
4. Inspect the service worker and page consoles for capture, OCR, face, and backend errors. `pii-accuracy-test.html` and `face-detection.html` are available for focused checks.

Raw screenshots are captured and processed locally before the sanitized payload is sent to the backend. The popup's current backend endpoint is `https://devins.onrender.com/analyze`. OCR uses Tesseract.js defaults without explicit local worker/core/language paths, and BlazeFace loads its default model; these dependencies may require network access. `worker.min.js` is packaged, but the current OCR initialization does not explicitly select it. The ML libraries and algorithms have not been replaced or disabled in this build.

## Backend Configuration

The endpoint is currently defined as `API_URL` in `sih-agent/extension/popup.js`. To use another deployment, update that URL and rebuild. The Chromium manifest currently permits HTTP and HTTPS hosts because the extension runs on arbitrary web pages and the backend can be hosted separately. If narrowing host access, add the page origins needed by content scripts and the backend origin to `host_permissions`; the backend must also allow the extension origin through CORS. The included backend currently has permissive CORS configuration.

A local backend can be started from `sih-agent/backend` with `python -m uvicorn main:app --host 127.0.0.1 --port 8000`, after installing `requirements.txt` and configuring its VLM service. Set the popup endpoint to `http://127.0.0.1:8000/analyze` before rebuilding.

## Compatibility Notes

The Chromium background is a Manifest V3 service worker. Its `window`/`document` sandbox path is guarded for Firefox's extension-document context, so Chromium does not invoke it. The packaged Chromium manifest removes Gecko metadata and the Firefox `background.scripts` key. Browser installation and end-to-end runtime testing have not been performed; see [COMPATIBILITY.md](COMPATIBILITY.md).