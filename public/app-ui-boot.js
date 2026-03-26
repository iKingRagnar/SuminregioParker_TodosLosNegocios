// #region agent log
(function () {
  function send() {
    var muted = "";
    try {
      muted = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
    } catch (e) {}
    var payload = {
      sessionId: "5e0522",
      location: "app-ui-boot.js",
      message: "ui-load",
      hypothesisId: "H5",
      data: {
        path: typeof location !== "undefined" ? location.pathname : "",
        appDark: document.body && document.body.classList.contains("app-dark"),
        hasAppUiLink: !!document.querySelector('link[href*="app-ui.css"]'),
        muted: muted
      },
      timestamp: Date.now()
    };
    fetch("http://127.0.0.1:7845/ingest/dccd4d73-a0a8-497c-b252-2fef711ed56a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "5e0522" },
      body: JSON.stringify(payload)
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", send);
  else send();
})();
// #endregion
