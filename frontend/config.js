// Local development defaults. For production, set API_BASE in GitHub repo
// variable API_BASE (see .github/workflows/deploy-frontend.yml) or edit this file.
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  // Optional: Erlang/OTP messaging node. Omit to use FastAPI WebSockets.
  // WS_BASE: "ws://127.0.0.1:8080/v1",
};
