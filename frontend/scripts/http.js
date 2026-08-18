(function () {
  "use strict";

  if (!window.fetch || window.__dcFetchTimeoutInstalled) return;
  window.__dcFetchTimeoutInstalled = true;

  var nativeFetch = window.fetch.bind(window);
  var defaultTimeoutMs = Number(window.APP_HTTP_TIMEOUT_MS || 10000);

  window.fetch = function (input, init) {
    init = init || {};

    var timeoutMs = typeof init.timeoutMs === "number" ? init.timeoutMs : defaultTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") {
      var passthrough = Object.assign({}, init);
      delete passthrough.timeoutMs;
      return nativeFetch(input, passthrough);
    }

    var controller = new AbortController();
    var timedOut = false;
    var originalSignal = init.signal;
    var options = Object.assign({}, init, { signal: controller.signal });
    delete options.timeoutMs;

    if (originalSignal) {
      if (originalSignal.aborted) {
        controller.abort();
      } else {
        originalSignal.addEventListener(
          "abort",
          function () {
            controller.abort();
          },
          { once: true }
        );
      }
    }

    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    return nativeFetch(input, options)
      .catch(function (error) {
        if (timedOut) {
          var timeoutError = new Error("Request timed out");
          timeoutError.name = "TimeoutError";
          throw timeoutError;
        }
        throw error;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  };
})();
