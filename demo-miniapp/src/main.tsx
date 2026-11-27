import "@fontsource-variable/inter";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { DemoStoreProvider } from "./hooks/use-demo-store";
import { initTelegram } from "./lib/telegram";

initTelegram();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoStoreProvider>
      <App />
    </DemoStoreProvider>
  </StrictMode>,
);
