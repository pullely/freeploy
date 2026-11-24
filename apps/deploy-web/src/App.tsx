import { pageFor } from "./routes";
import { LoginPage } from "./pages/Login";
import { RegisterPage } from "./pages/Register";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { ConfirmPasswordPage } from "./pages/ConfirmPassword";
import { NotPortedPage } from "./pages/NotPorted";
import { PasskeysConfirmPage } from "./pages/PasskeysConfirm";
import { VerifyEmailPage, EmailVerifyLinkPage } from "./pages/VerifyEmail";
import { TwoFactorChallengePage } from "./pages/TwoFactorChallenge";
import { lazy, Suspense, useEffect } from "react";

// Signed-in pages carry Coolify's whole layout; guest pages do not load it.
const TwoFactorRequiredPage = lazy(() => import("./pages/TwoFactorRequired").then((m) => ({ default: m.TwoFactorRequiredPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const AppearancePage = lazy(() => import("./pages/Appearance").then((m) => ({ default: m.AppearancePage })));
const PrivateKeysPage = lazy(() => import("./pages/PrivateKeys").then((m) => ({ default: m.PrivateKeysPage })));

/** routes/web.php: security.private-key.show is redirect()->route('security.private-key.index'). */
function RedirectTo({ path }: { path: string }) {
  useEffect(() => window.location.replace(path), [path]);
  return null;
}

export function App() {
  switch (pageFor(window.location.pathname)) {
    case "login":
      return <LoginPage />;
    case "register":
      return <RegisterPage />;
    case "forgot-password":
      return <ForgotPasswordPage />;
    case "reset-password":
      return <ResetPasswordPage />;
    case "two-factor.required":
      return (
        <Suspense fallback={null}>
          <TwoFactorRequiredPage />
        </Suspense>
      );
    case "profile.passkeys.confirm":
      return <PasskeysConfirmPage />;
    case "verify.email":
      return <VerifyEmailPage />;
    case "verify.verify":
      return <EmailVerifyLinkPage />;
    case "password.confirm":
      return <ConfirmPasswordPage />;
    case "two-factor.login":
      return <TwoFactorChallengePage />;
    case "profile":
      return (
        <Suspense fallback={null}>
          <ProfilePage />
        </Suspense>
      );
    case "profile.appearance":
      return (
        <Suspense fallback={null}>
          <AppearancePage />
        </Suspense>
      );
    case "security.private-key.index":
      return (
        <Suspense fallback={null}>
          <PrivateKeysPage />
        </Suspense>
      );
    case "security.private-key.show":
      return <RedirectTo path="/security/private-key" />;
    default:
      return <NotPortedPage />;
  }
}
