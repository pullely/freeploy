# Security policy

Freeploy holds SSH private keys for its customers' servers. We treat that as
the most sensitive thing it does.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability). We
acknowledge within 3 working days and aim to ship a fix or mitigation within
30 days, sooner for anything that can expose keys or cross a tenant boundary.

If the issue is also present in upstream Coolify, we will coordinate with the
Coolify maintainers through their own security process before disclosure.

## What we consider in scope

- Anything that lets one org read, change or act on another org's data,
  servers, keys or resources (tenancy is the security boundary).
- Exposure of private keys, API tokens, provider tokens or webhook secrets.
- Command injection into the shell commands run on customer servers.
- Authentication and session issues (sign-in, 2FA, passkeys, API tokens).

## How keys are handled

- Private keys are encrypted with a per-org data key (envelope encryption)
  and decrypted only inside the SSH executor, per request. They are never
  logged.
- Host keys are pinned on first connect and shown in the UI.
- Every command run on a server is written to the org's audit log.
- Commands are generated only by the ported helpers, which are tested
  byte-for-byte against Coolify's.

## Incident plan (summary)

1. Contain: revoke affected tokens and sessions; disable the affected
   executor path; rotate the platform wrapping key if key envelopes may be
   exposed.
2. Rotate: run key rotation for affected orgs (ported `RotatePrivateKeyJob`),
   and notify org owners with the exact servers and keys involved.
3. Disclose: publish an advisory once fixed.
