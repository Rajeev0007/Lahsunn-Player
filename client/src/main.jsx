import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/* Registering the service worker is what makes the app installable. A standalone
 * PWA keeps audio playing far more reliably in the background on mobile than a
 * regular browser tab does. Requires a secure context (https, or localhost). */
if ("serviceWorker" in navigator && (window.isSecureContext || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is optional; playback works without it */
    });
  });
}
