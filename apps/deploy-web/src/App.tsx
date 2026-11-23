import { pageFor } from "./routes";
import { LoginPage } from "./pages/Login";

export function App() {
  switch (pageFor(window.location.pathname)) {
    case "login":
      return <LoginPage />;
    default:
      return <NotPorted />;
  }
}

function NotPorted() {
  return <main data-freeploy-not-ported="" />;
}
