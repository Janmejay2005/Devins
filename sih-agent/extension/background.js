console.log(" SIH Privacy Agent background service started");

chrome.runtime.onInstalled.addListener(() => {
    console.log(" SIH Privacy Agent installed");
});