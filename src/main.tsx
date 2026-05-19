import { ClerkProvider } from "@clerk/clerk-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const app = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  clerkPublishableKey ? (
    <ClerkProvider publishableKey={clerkPublishableKey}>{app}</ClerkProvider>
  ) : (
    app
  )
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[pwa] service worker registration failed", error);
    });
  });
}
