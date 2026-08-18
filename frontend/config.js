// Local when opened on 127.0.0.1 / localhost. Otherwise use the live API and WS.
(function () {
  var host = (typeof location !== "undefined" && location.hostname) || "";
  var local = host === "127.0.0.1" || host === "localhost";
  window.APP_CONFIG = local
    ? {
        API_BASE: "http://127.0.0.1:8000/v1",
        WS_BASE: "ws://127.0.0.1:8080/v1",
      }
    : {
        API_BASE: "https://api.techgroupkenya.co.ke/v1",
        WS_BASE: "wss://ws.techgroupkenya.co.ke/v1",
      };
})();
