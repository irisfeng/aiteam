import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { WorkspaceProvider } from "./store";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceProvider>
      <App />
    </WorkspaceProvider>
  </StrictMode>
);
