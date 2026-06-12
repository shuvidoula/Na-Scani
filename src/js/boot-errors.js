(function () {
  "use strict";

  window.__bootErrors = [];
  window.addEventListener("error", function (event) {
    window.__bootErrors.push({
      message: event.message || "Script error",
      source: event.filename || "",
      line: event.lineno || 0,
      column: event.colno || 0
    });
  }, true);
}());
