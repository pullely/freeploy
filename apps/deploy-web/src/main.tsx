import "./css/app.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyLayoutDefaults, applyStoredTheme } from "./theme";

applyLayoutDefaults();
applyStoredTheme();
createRoot(document.getElementById("app")!).render(<App />);
