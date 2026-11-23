import { pageFor } from "./routes";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { ForgotPasswordPage } from "./pages/ForgotPassword";

export function App() {
  switch (pageFor(window.location.pathname)) {
    case "login":
      return <LoginPage />;
    case "register":
      return <RegisterPage />;
    case "forgot-password":
      return <ForgotPasswordPage />;
    default:
      return <NotPorted />;
  }
}

function NotPorted() {
  return <main data-freeploy-not-ported="" />;
}
