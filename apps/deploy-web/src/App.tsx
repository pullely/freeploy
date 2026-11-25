import { pageFor, backupScheduleRedirect } from "./routes";
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
const ResourceCreatePage = lazy(() => import("./pages/ResourceCreate").then((m) => ({ default: m.ResourceCreatePage })));
const ServiceShowPage = lazy(() => import("./pages/ServiceShow").then((m) => ({ default: m.ServiceShowPage })));
const ServicePartPage = lazy(() => import("./pages/ServicePart").then((m) => ({ default: m.ServicePartPage })));
const ServiceEnvironmentVariablesPage = lazy(() => import("./pages/ServiceSharedPages").then((m) => ({ default: m.ServiceEnvironmentVariablesPage })));
const ServiceStoragesPage = lazy(() => import("./pages/ServiceSharedPages").then((m) => ({ default: m.ServiceStoragesPage })));
const ServiceTagsPage = lazy(() => import("./pages/ServiceSharedPages").then((m) => ({ default: m.ServiceTagsPage })));
const ServiceDangerPage = lazy(() => import("./pages/ServiceSharedPages").then((m) => ({ default: m.ServiceDangerPage })));
const ApplicationGeneralPage = lazy(() => import("./pages/ApplicationGeneral").then((m) => ({ default: m.ApplicationGeneralPage })));
const ApplicationDomainsPage = lazy(() => import("./pages/ApplicationDomains").then((m) => ({ default: m.ApplicationDomainsPage })));
const ApplicationAdvancedPage = lazy(() => import("./pages/ApplicationAdvanced").then((m) => ({ default: m.ApplicationAdvancedPage })));
const ApplicationHealthcheckPage = lazy(() => import("./pages/ApplicationHealthcheck").then((m) => ({ default: m.ApplicationHealthcheckPage })));
const ApplicationResourceLimitsPage = lazy(() => import("./pages/ApplicationResourceLimits").then((m) => ({ default: m.ApplicationResourceLimitsPage })));
const ApplicationEnvironmentVariablesPage = lazy(() => import("./pages/ApplicationEnvironmentVariables").then((m) => ({ default: m.ApplicationEnvironmentVariablesPage })));
const ApplicationDeploymentsPage = lazy(() => import("./pages/ApplicationDeployments").then((m) => ({ default: m.ApplicationDeploymentsPage })));
const ApplicationDeploymentPage = lazy(() => import("./pages/ApplicationDeployment").then((m) => ({ default: m.ApplicationDeploymentPage })));
const ApplicationStoragesPage = lazy(() => import("./pages/ApplicationStorages").then((m) => ({ default: m.ApplicationStoragesPage })));
const ApplicationTagsPage = lazy(() => import("./pages/ApplicationTags").then((m) => ({ default: m.ApplicationTagsPage })));
const ApplicationResourceOperationsPage = lazy(() => import("./pages/ApplicationResourceOperations").then((m) => ({ default: m.ApplicationResourceOperationsPage })));
const DatabaseGeneralPage = lazy(() => import("./pages/DatabaseGeneral").then((m) => ({ default: m.DatabaseGeneralPage })));
const DatabaseEnvironmentVariablesPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseEnvironmentVariablesPage })));
const DatabaseStoragesPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseStoragesPage })));
const DatabaseTagsPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseTagsPage })));
const DatabaseResourceOperationsPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseResourceOperationsPage })));
const DatabaseResourceLimitsPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseResourceLimitsPage })));
const DatabaseWebhooksPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseWebhooksPage })));
const DatabaseDangerPage = lazy(() => import("./pages/DatabaseSharedPages").then((m) => ({ default: m.DatabaseDangerPage })));
const ApplicationDangerPage = lazy(() => import("./pages/ApplicationDanger").then((m) => ({ default: m.ApplicationDangerPage })));
const ApplicationSourcePage = lazy(() => import("./pages/ApplicationSource").then((m) => ({ default: m.ApplicationSourcePage })));
const ApplicationServersPage = lazy(() => import("./pages/ApplicationServers").then((m) => ({ default: m.ApplicationServersPage })));
const ApplicationWebhooksPage = lazy(() => import("./pages/ApplicationWebhooks").then((m) => ({ default: m.ApplicationWebhooksPage })));
const ApplicationScheduledTasksPage = lazy(() => import("./pages/ApplicationScheduledTasks").then((m) => ({ default: m.ApplicationScheduledTasksPage })));
const ApplicationRollbackPage = lazy(() => import("./pages/ApplicationRollback").then((m) => ({ default: m.ApplicationRollbackPage })));
const EnvironmentEditPage = lazy(() => import("./pages/EnvironmentEdit").then((m) => ({ default: m.EnvironmentEditPage })));
const PrivateKeysPage = lazy(() => import("./pages/PrivateKeys").then((m) => ({ default: m.PrivateKeysPage })));
const CloudTokensPage = lazy(() => import("./pages/CloudTokens").then((m) => ({ default: m.CloudTokensPage })));
const CloudTokenShowPage = lazy(() => import("./pages/CloudTokenEditor").then((m) => ({ default: m.CloudTokenShowPage })));
const ApiTokensPage = lazy(() => import("./pages/ApiTokens").then((m) => ({ default: m.ApiTokensPage })));
const CloudInitScriptsPage = lazy(() => import("./pages/CloudInitScripts").then((m) => ({ default: m.CloudInitScriptsPage })));
const CloudInitScriptShowPage = lazy(() => import("./pages/CloudInitScriptEditor").then((m) => ({ default: m.CloudInitScriptShowPage })));
const ServerCloudTokenPage = lazy(() => import("./pages/ServerCloudToken").then((m) => ({ default: m.ServerCloudTokenPage })));
const ServerCaCertificatePage = lazy(() => import("./pages/ServerCaCertificate").then((m) => ({ default: m.ServerCaCertificatePage })));
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
const ServerRegistriesPage = lazy(() => import("./pages/ServerRegistries").then((m) => ({ default: m.ServerRegistriesPage })));
const RegistriesPage = lazy(() => import("./pages/Registries").then((m) => ({ default: m.RegistriesPage })));
const SharedVariablesPage = lazy(() => import("./pages/SharedVariables").then((m) => ({ default: m.SharedVariablesPage })));
const DestinationsPage = lazy(() => import("./pages/Destinations").then((m) => ({ default: m.DestinationsPage })));
const DestinationShowPage = lazy(() => import("./pages/DestinationShow").then((m) => ({ default: m.DestinationShowPage })));
const DestinationResourcesPage = lazy(() => import("./pages/DestinationResources").then((m) => ({ default: m.DestinationResourcesPage })));
const StoragesPage = lazy(() => import("./pages/Storages").then((m) => ({ default: m.StoragesPage })));
const StorageShowPage = lazy(() => import("./pages/Storages").then((m) => ({ default: m.StorageShowPage })));
const DatabaseBackupsPage = lazy(() => import("./pages/DatabaseBackups").then((m) => ({ default: m.DatabaseBackupsPage })));
const ServerDeletePage = lazy(() => import("./pages/ServerDelete").then((m) => ({ default: m.ServerDeletePage })));
const NotificationSettingsPage = lazy(() => import("./pages/NotificationSettings").then((m) => ({ default: m.NotificationSettingsPage })));
const TeamGeneralPage = lazy(() => import("./pages/Team").then((m) => ({ default: m.TeamGeneralPage })));
const TeamMembersPage = lazy(() => import("./pages/Team").then((m) => ({ default: m.TeamMembersPage })));
const InvitationPage = lazy(() => import("./pages/Team").then((m) => ({ default: m.InvitationPage })));

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
    case "project.resource.create":
      return (
        <Suspense fallback={null}>
          <ResourceCreatePage />
        </Suspense>
      );
    case "project.application.configuration":
      return (
        <Suspense fallback={null}>
          <ApplicationGeneralPage />
        </Suspense>
      );
    case "project.application.domains":
      return (
        <Suspense fallback={null}>
          <ApplicationDomainsPage />
        </Suspense>
      );
    case "project.application.advanced":
      return (
        <Suspense fallback={null}>
          <ApplicationAdvancedPage />
        </Suspense>
      );
    case "project.application.healthcheck":
      return (
        <Suspense fallback={null}>
          <ApplicationHealthcheckPage />
        </Suspense>
      );
    case "project.application.resource-limits":
      return (
        <Suspense fallback={null}>
          <ApplicationResourceLimitsPage />
        </Suspense>
      );
    case "project.application.environment-variables":
      return (
        <Suspense fallback={null}>
          <ApplicationEnvironmentVariablesPage />
        </Suspense>
      );
    case "project.application.persistent-storage":
      return (
        <Suspense fallback={null}>
          <ApplicationStoragesPage />
        </Suspense>
      );
    case "project.application.tags":
      return (
        <Suspense fallback={null}>
          <ApplicationTagsPage />
        </Suspense>
      );
    case "project.application.resource-operations":
      return (
        <Suspense fallback={null}>
          <ApplicationResourceOperationsPage />
        </Suspense>
      );
    case "project.application.danger":
      return (
        <Suspense fallback={null}>
          <ApplicationDangerPage />
        </Suspense>
      );
    case "project.application.source":
      return (
        <Suspense fallback={null}>
          <ApplicationSourcePage />
        </Suspense>
      );
    case "project.application.servers":
      return (
        <Suspense fallback={null}>
          <ApplicationServersPage />
        </Suspense>
      );
    case "project.application.webhooks":
      return (
        <Suspense fallback={null}>
          <ApplicationWebhooksPage />
        </Suspense>
      );
    case "project.application.scheduled-tasks":
      return (
        <Suspense fallback={null}>
          <ApplicationScheduledTasksPage />
        </Suspense>
      );
    case "project.application.rollback":
      return (
        <Suspense fallback={null}>
          <ApplicationRollbackPage />
        </Suspense>
      );
    case "project.database.configuration":
      return (
        <Suspense fallback={null}>
          <DatabaseGeneralPage />
        </Suspense>
      );
    case "project.database.environment-variables":
      return (
        <Suspense fallback={null}>
          <DatabaseEnvironmentVariablesPage />
        </Suspense>
      );
    case "project.database.persistent-storage":
      return (
        <Suspense fallback={null}>
          <DatabaseStoragesPage />
        </Suspense>
      );
    case "project.database.tags":
      return (
        <Suspense fallback={null}>
          <DatabaseTagsPage />
        </Suspense>
      );
    case "project.database.resource-operations":
      return (
        <Suspense fallback={null}>
          <DatabaseResourceOperationsPage />
        </Suspense>
      );
    case "project.database.resource-limits":
      return (
        <Suspense fallback={null}>
          <DatabaseResourceLimitsPage />
        </Suspense>
      );
    case "project.database.webhooks":
      return (
        <Suspense fallback={null}>
          <DatabaseWebhooksPage />
        </Suspense>
      );
    case "project.database.danger":
      return (
        <Suspense fallback={null}>
          <DatabaseDangerPage />
        </Suspense>
      );
    case "project.application.deployment.index":
      return (
        <Suspense fallback={null}>
          <ApplicationDeploymentsPage />
        </Suspense>
      );
    case "project.application.deployment.show":
      return (
        <Suspense fallback={null}>
          <ApplicationDeploymentPage />
        </Suspense>
      );
    case "project.service.configuration":
      return (
        <Suspense fallback={null}>
          <ServiceShowPage />
        </Suspense>
      );
    case "project.service.index":
      return (
        <Suspense fallback={null}>
          <ServicePartPage />
        </Suspense>
      );
    case "project.service.environment-variables":
      return (
        <Suspense fallback={null}>
          <ServiceEnvironmentVariablesPage />
        </Suspense>
      );
    case "project.service.storages":
      return (
        <Suspense fallback={null}>
          <ServiceStoragesPage />
        </Suspense>
      );
    case "project.service.tags":
      return (
        <Suspense fallback={null}>
          <ServiceTagsPage />
        </Suspense>
      );
    case "project.service.danger":
      return (
        <Suspense fallback={null}>
          <ServiceDangerPage />
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
    case "security.api-tokens":
      return (
        <Suspense fallback={null}>
          <ApiTokensPage />
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
    case "server.ca-certificate":
      return (
        <Suspense fallback={null}>
          <ServerCaCertificatePage />
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
    case "server.registries":
      return (
        <Suspense fallback={null}>
          <ServerRegistriesPage />
        </Suspense>
      );
    case "shared-variables.index":
    case "shared-variables.team.index":
    case "shared-variables.project.index":
    case "shared-variables.project.show":
    case "shared-variables.environment.index":
    case "shared-variables.environment.show":
    case "shared-variables.server.index":
    case "shared-variables.server.show":
      return (
        <Suspense fallback={null}>
          <SharedVariablesPage page={pageFor(window.location.pathname)} />
        </Suspense>
      );
    case "registries.index":
      return (
        <Suspense fallback={null}>
          <RegistriesPage />
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
    case "storage.index":
      return (
        <Suspense fallback={null}>
          <StoragesPage />
        </Suspense>
      );
    case "storage.show":
    case "storage.resources":
    case "storage.danger":
      return (
        <Suspense fallback={null}>
          <StorageShowPage tab={({ "storage.show": "general", "storage.resources": "resources", "storage.danger": "danger" } as const)[pageFor(window.location.pathname) as "storage.show"]} />
        </Suspense>
      );
    case "project.database.backup.index":
      return (
        <Suspense fallback={null}>
          <DatabaseBackupsPage />
        </Suspense>
      );
    case "project.database.backup.show":
      return <RedirectTo path={backupScheduleRedirect(window.location.pathname)} />;
    case "notifications.email":
    case "notifications.discord":
    case "notifications.telegram":
    case "notifications.slack":
    case "notifications.pushover":
    case "notifications.webhook":
      return (
        <Suspense fallback={null}>
          <NotificationSettingsPage channel={pageFor(window.location.pathname).slice("notifications.".length) as "email"} />
        </Suspense>
      );
    case "team.index":
      return (
        <Suspense fallback={null}>
          <TeamGeneralPage />
        </Suspense>
      );
    case "team.member.index":
      return (
        <Suspense fallback={null}>
          <TeamMembersPage />
        </Suspense>
      );
    case "team.invitation.show":
      return (
        <Suspense fallback={null}>
          <InvitationPage />
        </Suspense>
      );
    default:
      return <NotPortedPage />;
  }
}
