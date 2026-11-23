import "./css/app.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredTheme } from "./theme";

applyStoredTheme();
createRoot(document.getElementById("app")!).render(<App />);
