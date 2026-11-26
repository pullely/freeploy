// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/parsers.php (validateDockerComposeForInjection,
// validateVolumeStringForInjection, validateComposeNetworkNameField, validateComposeNetworkNameWithVariables,
// validateComposeNetworkName, invalidComposeNetworkNameException, COMPOSE_NETWORK_VARIABLE_PATTERN,
// isSafeComposeNetworkVariableOperand) (Apache-2.0), modified.
//
// The check a Compose file passes before Coolify stores it (StackForm::submit() calls it before anything is
// saved): valid YAML with a `services:` section, and no service name, volume or network that a shell could
// read as more than a name. Each refusal is the exception Coolify raises, word for word.
import { PhpArray, type PhpValue } from "../compose/php.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import {
  ComposeError,
  composeNetworkNameVariable,
  isComposeExternalVolume,
  isValidDockerNetwork,
  parseDockerVolumeString,
  rejectComposeVolumeTargetVariable,
  validateComposeArrayVolumeSource,
  validateComposeContentVolumeSource,
  validateComposeExternalVolume,
  validateComposeServiceName,
  validateShellSafePath,
} from "./compose-helpers.js";

/** COMPOSE_NETWORK_VARIABLE_PATTERN, global. */
const COMPOSE_NETWORK_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?+])([^}]*))?\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

/** isSafeComposeNetworkVariableOperand() */
function isSafeComposeNetworkVariableOperand(operator: string, operand: string): boolean {
  return (operator === "?" ? /^[A-Za-z0-9 _.,:!-]*$/ : /^[A-Za-z0-9_.-]*$/).test(operand);
}

function invalidComposeNetworkName(name: string, context: string, serviceName: string | null, allowsVariables = false): ComposeError {
  const location = serviceName === null ? "" : ` in service ${serviceName}`;
  return new ComposeError(
    `Invalid Docker Compose ${context} "${name}"${location}. Network names must start with an alphanumeric character and contain only alphanumeric characters, dots, hyphens, and underscores` +
      (allowsVariables ? ", and can use variables such as ${NETWORK:-default}." : "."),
  );
}

/** validateComposeNetworkNameWithVariables() */
export function validateComposeNetworkNameWithVariables(name: string, context: string, serviceName: string | null = null): void {
  const variable = composeNetworkNameVariable(name);
  let isValid: boolean;
  if (variable !== null && variable.default !== null) {
    isValid = isValidDockerNetwork(variable.default);
  } else {
    let hasSafeDefaults = true;
    const withoutVariables = name.replace(COMPOSE_NETWORK_VARIABLE, (_match, _name: string | undefined, operator: string | undefined, operand: string | undefined) => {
      if (!isSafeComposeNetworkVariableOperand(operator ?? "", operand ?? "")) hasSafeDefaults = false;
      return "x";
    });
    isValid = hasSafeDefaults && isValidDockerNetwork(withoutVariables);
  }
  if (!isValid) throw invalidComposeNetworkName(name, context, serviceName, true);
}

/** validateComposeNetworkName() */
export function validateComposeNetworkName(networkName: string, context = "network name", serviceName: string | null = null): void {
  if (networkName === "" || !isValidDockerNetwork(networkName)) throw invalidComposeNetworkName(networkName, context, serviceName);
}

const key = (value: string | number): string => String(value);

/** validateDockerComposeForInjection(): throws ComposeError with Coolify's message for a file it would refuse. */
export function validateDockerComposeForInjection(composeYaml: string): void {
  let parsed: PhpValue;
  try {
    parsed = parseDockerComposeYaml(composeYaml);
  } catch (error) {
    throw new ComposeError(`Invalid YAML format: ${(error as Error).message}`);
  }
  const services = parsed instanceof PhpArray ? parsed.get("services") : undefined;
  if (!(parsed instanceof PhpArray) || !(services instanceof PhpArray)) throw new ComposeError('Docker Compose file must contain a "services" section');

  for (const [serviceName, serviceConfig] of services.entries()) {
    try {
      validateShellSafePath(key(serviceName), "service name");
    } catch (error) {
      throw new ComposeError(`Invalid Docker Compose service name: ${(error as Error).message} Service names must not contain shell metacharacters.`);
    }
    validateComposeServiceName(key(serviceName));

    const volumes = serviceConfig instanceof PhpArray ? serviceConfig.get("volumes") : undefined;
    if (volumes instanceof PhpArray) {
      for (const volume of volumes.values()) {
        if (typeof volume === "string") {
          // validateVolumeStringForInjection(): the canonical parse throws on unsafe input.
          parseDockerVolumeString(volume);
        } else if (volume instanceof PhpArray) {
          const source = volume.get("source");
          if (typeof source === "string") validateComposeArrayVolumeSource(source);
          const target = volume.get("target");
          if (typeof target === "string") {
            rejectComposeVolumeTargetVariable(target, "Invalid Docker volume definition (array syntax)");
            try {
              validateShellSafePath(target, "volume target");
            } catch (error) {
              throw new ComposeError(`Invalid Docker volume definition (array syntax): ${(error as Error).message} Please use safe path names without shell metacharacters.`);
            }
          }
          validateComposeContentVolumeSource(volume);
        }
      }
    }

    const networks = serviceConfig instanceof PhpArray ? serviceConfig.get("networks") : undefined;
    if (networks instanceof PhpArray) {
      for (const [networkKey, networkDetails] of networks.entries()) {
        if (typeof networkKey === "number" && (typeof networkDetails === "string" || (typeof networkDetails === "number" && Number.isInteger(networkDetails)))) {
          validateComposeNetworkNameWithVariables(String(networkDetails), "service network", key(serviceName));
        } else {
          // Compose does not interpolate keys, so a key must be a plain network name.
          validateComposeNetworkName(key(networkKey), "service network", key(serviceName));
        }
      }
    }
  }

  const networks = parsed.get("networks");
  if (networks instanceof PhpArray) {
    for (const [networkName, networkConfig] of networks.entries()) {
      validateComposeNetworkName(key(networkName));
      const name = networkConfig instanceof PhpArray ? networkConfig.get("name") : undefined;
      // validateComposeNetworkNameField()
      if (typeof name === "string") validateComposeNetworkNameWithVariables(name, "network name field");
    }
  }

  const volumes = parsed.get("volumes");
  if (volumes instanceof PhpArray) {
    for (const [volumeName, volumeConfig] of volumes.entries()) {
      if (isComposeExternalVolume(volumeConfig)) validateComposeExternalVolume(key(volumeName), volumeConfig as PhpArray);
    }
  }
}
