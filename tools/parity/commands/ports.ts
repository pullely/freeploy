// The TypeScript ports the command goldens are checked against, keyed by the
// Coolify helper name. Each milestone that ports a helper registers it here
// (DP4: docker/proxy/remoteProcess helpers, DP5: applications, …); a case whose
// helper is not registered is reported `pending`, never as a pass.
import { __ } from "../../../apps/identity-worker/src/laravel-messages.ts";
import { normalize_email_identity } from "../../../apps/identity-worker/src/email-identity.ts";
import {
  caddyTrafficAppKey,
  composeProjectMountsCommand,
  composeServiceVolumeTargets,
  containerIdsByOwnerScript,
  dockerCommandIgnoringError,
  dockerEngineVersionFromJson,
  dockerNetworkRemoveCommand,
  dockerPsByOwnerCommands,
  dockerReadOnlyFileMountOption,
  dockerRemoveCommand,
  dockerRemoveCommandWithTimeout,
  dockerStopCommand,
  dockerStopTimeoutOption,
  escapeShellValue,
  parseDockerEngineVersion,
  traefikSafeServiceNameSegment,
  traefikServiceNameHash,
} from "../../../apps/deploy-core-worker/src/helpers/docker.ts";
import {
  dockerNetworkEnsureCommand,
  dockerProxyNetworkEnsureCommand,
  isDockerPredefinedNetwork,
  isUsableDockerNetworkName,
  traefikAccessLogCommands,
  traefikAccessLogRotationScript,
} from "../../../apps/deploy-core-worker/src/helpers/proxy.ts";
import {
  remoteCommandWithTimeout,
  remove_iip,
  sanitize_utf8_text,
} from "../../../apps/deploy-core-worker/src/helpers/remote-process.ts";

export type Port = (...args: never[]) => unknown;
export const PORTS: Record<string, Port> = {
  // Laravel's translator, for the auth and validation messages Coolify shows (DP3).
  __: __ as Port,
  // bootstrap/helpers/email.php (DP3).
  normalize_email_identity: normalize_email_identity as Port,
  // bootstrap/helpers/docker.php (DP4).
  caddyTrafficAppKey: caddyTrafficAppKey as Port,
  composeProjectMountsCommand: composeProjectMountsCommand as Port,
  composeServiceVolumeTargets: composeServiceVolumeTargets as Port,
  containerIdsByOwnerScript: containerIdsByOwnerScript as Port,
  dockerCommandIgnoringError: dockerCommandIgnoringError as Port,
  dockerEngineVersionFromJson: dockerEngineVersionFromJson as Port,
  dockerNetworkRemoveCommand: dockerNetworkRemoveCommand as Port,
  dockerPsByOwnerCommands: dockerPsByOwnerCommands as Port,
  dockerReadOnlyFileMountOption: dockerReadOnlyFileMountOption as Port,
  dockerRemoveCommand: dockerRemoveCommand as Port,
  dockerRemoveCommandWithTimeout: dockerRemoveCommandWithTimeout as Port,
  dockerStopCommand: dockerStopCommand as Port,
  dockerStopTimeoutOption: dockerStopTimeoutOption as Port,
  escapeShellValue: escapeShellValue as Port,
  parseDockerEngineVersion: parseDockerEngineVersion as Port,
  traefikSafeServiceNameSegment: traefikSafeServiceNameSegment as Port,
  traefikServiceNameHash: traefikServiceNameHash as Port,
  // bootstrap/helpers/proxy.php (DP4).
  dockerNetworkEnsureCommand: dockerNetworkEnsureCommand as Port,
  dockerProxyNetworkEnsureCommand: dockerProxyNetworkEnsureCommand as Port,
  isDockerPredefinedNetwork: isDockerPredefinedNetwork as Port,
  isUsableDockerNetworkName: isUsableDockerNetworkName as Port,
  traefikAccessLogCommands: traefikAccessLogCommands as Port,
  traefikAccessLogRotationScript: traefikAccessLogRotationScript as Port,
  // bootstrap/helpers/remoteProcess.php (DP4).
  remoteCommandWithTimeout: remoteCommandWithTimeout as Port,
  remove_iip: remove_iip as Port,
  sanitize_utf8_text: sanitize_utf8_text as Port,
};
