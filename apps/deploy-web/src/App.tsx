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
const ProjectsPage = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectsPage })));
const ProjectShowPage = lazy(() => import("./pages/ProjectShow").then((m) => ({ default: m.ProjectShowPage })));
const ProjectEditPage = lazy(() => import("./pages/ProjectEdit").then((m) => ({ default: m.ProjectEditPage })));
const EnvironmentResourcesPage = lazy(() => import("./pages/EnvironmentResources").then((m) => ({ default: m.EnvironmentResourcesPage })));
const EnvironmentEditPage = lazy(() => import("./pages/EnvironmentEdit").then((m) => ({ default: m.EnvironmentEditPage })));
const PrivateKeysPage = lazy(() => import("./pages/PrivateKeys").then((m) => ({ default: m.PrivateKeysPage })));
const CloudTokensPage = lazy(() => import("./pages/CloudTokens").then((m) => ({ default: m.CloudTokensPage })));
const CloudTokenShowPage = lazy(() => import("./pages/CloudTokenEditor").then((m) => ({ default: m.CloudTokenShowPage })));
const CloudInitScriptsPage = lazy(() => import("./pages/CloudInitScripts").then((m) => ({ default: m.CloudInitScriptsPage })));
const CloudInitScriptShowPage = lazy(() => import("./pages/CloudInitScriptEditor").then((m) => ({ default: m.CloudInitScriptShowPage })));
const ServerCloudTokenPage = lazy(() => import("./pages/ServerCloudToken").then((m) => ({ default: m.ServerCloudTokenPage })));
const ServersPage = lazy(() => import("./pages/Servers").then((m) => ({ default: m.ServersPage })));
const ServerCreatePage = lazy(() => import("./pages/ServerCreate").then((m) => ({ default: m.ServerCreatePage })));
const ServerShowPage = lazy(() => import("./pages/ServerShow").then((m) => ({ default: m.ServerShowPage })));
const ServerPrivateKeyPage = lazy(() => import("./pages/ServerPrivateKey").then((m) => ({ default: m.ServerPrivateKeyPage })));
const ServerAdvancedPage = lazy(() => import("./pages/ServerAdvanced").then((m) => ({ default: m.ServerAdvancedPage })));
const ServerDockerCleanupPage = lazy(() => import("./pages/ServerDockerCleanup").then((m) => ({ default: m.ServerDockerCleanupPage })));
const ServerLogDrainsPage = lazy(() => import("./pages/ServerLogDrains").then((m) => ({ default: m.ServerLogDrainsPage })));
const ServerSwarmPage = lazy(() => import("./pages/ServerSwarm").then((m) => ({ default: m.ServerSwarmPage })));
const ServerSentinelPage = lazy(() => import("./pages/ServerSentinel").then((m) => ({ default: m.ServerSentinelPage })));
const ServerDestinationsPage = lazy(() => import("./pages/ServerDestinations").then((m) => ({ default: m.ServerDestinationsPage })));
const DestinationsPage = lazy(() => import("./pages/Destinations").then((m) => ({ default: m.DestinationsPage })));
const DestinationShowPage = lazy(() => import("./pages/DestinationShow").then((m) => ({ default: m.DestinationShowPage })));
const DestinationResourcesPage = lazy(() => import("./pages/DestinationResources").then((m) => ({ default: m.DestinationResourcesPage })));
const ServerDeletePage = lazy(() => import("./pages/ServerDelete").then((m) => ({ default: m.ServerDeletePage })));

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
    case "project.index":
      return (
        <Suspense fallback={null}>
          <ProjectsPage />
        </Suspense>
      );
    case "project.show":
      return (
        <Suspense fallback={null}>
          <ProjectShowPage />
        </Suspense>
      );
    case "project.edit":
      return (
        <Suspense fallback={null}>
          <ProjectEditPage />
        </Suspense>
      );
    case "project.resource.index":
      return (
        <Suspense fallback={null}>
          <EnvironmentResourcesPage />
        </Suspense>
      );
    case "project.environment.edit":
      return (
        <Suspense fallback={null}>
          <EnvironmentEditPage />
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
    case "security.cloud-tokens":
      return (
        <Suspense fallback={null}>
          <CloudTokensPage />
        </Suspense>
      );
    case "security.cloud-tokens.show":
      return (
        <Suspense fallback={null}>
          <CloudTokenShowPage />
        </Suspense>
      );
    case "security.cloud-init-scripts":
      return (
        <Suspense fallback={null}>
          <CloudInitScriptsPage />
        </Suspense>
      );
    case "security.cloud-init-scripts.show":
      return (
        <Suspense fallback={null}>
          <CloudInitScriptShowPage />
        </Suspense>
      );
    case "server.cloud-provider-token":
      return (
        <Suspense fallback={null}>
          <ServerCloudTokenPage />
        </Suspense>
      );
    case "server.index":
      return (
        <Suspense fallback={null}>
          <ServersPage />
        </Suspense>
      );
    case "server.create":
    case "server.create.manual":
      return (
        <Suspense fallback={null}>
          <ServerCreatePage manual={pageFor(window.location.pathname) === "server.create.manual"} />
        </Suspense>
      );
    case "server.show":
      return (
        <Suspense fallback={null}>
          <ServerShowPage />
        </Suspense>
      );
    case "server.private-key":
      return (
        <Suspense fallback={null}>
          <ServerPrivateKeyPage />
        </Suspense>
      );
    case "server.advanced":
      return (
        <Suspense fallback={null}>
          <ServerAdvancedPage />
        </Suspense>
      );
    case "server.docker-cleanup":
      return (
        <Suspense fallback={null}>
          <ServerDockerCleanupPage />
        </Suspense>
      );
    case "server.log-drains":
      return (
        <Suspense fallback={null}>
          <ServerLogDrainsPage />
        </Suspense>
      );
    case "server.swarm":
      return (
        <Suspense fallback={null}>
          <ServerSwarmPage />
        </Suspense>
      );
    case "server.sentinel":
      return (
        <Suspense fallback={null}>
          <ServerSentinelPage />
        </Suspense>
      );
    case "server.delete":
      return (
        <Suspense fallback={null}>
          <ServerDeletePage />
        </Suspense>
      );
    case "server.destinations":
      return (
        <Suspense fallback={null}>
          <ServerDestinationsPage />
        </Suspense>
      );
    case "destination.index":
      return (
        <Suspense fallback={null}>
          <DestinationsPage />
        </Suspense>
      );
    case "destination.show":
    case "destination.danger":
      return (
        <Suspense fallback={null}>
          <DestinationShowPage danger={pageFor(window.location.pathname) === "destination.danger"} />
        </Suspense>
      );
    case "destination.resources":
      return (
        <Suspense fallback={null}>
          <DestinationResourcesPage />
        </Suspense>
      );
    default:
      return <NotPortedPage />;
  }
}
