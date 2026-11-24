// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/general.blade.php
// (the Authentication sub-section of Access and the Labels sub-section of Container) and
// app/Livewire/Project/Application/General.php (instantSave, resetDefaultLabels) (Apache-2.0), modified.
//
// The two parts of an application's General page that depend on the container labels: HTTP Basic
// Authentication, and the labels themselves with their two settings. Copy is Coolify's with the product
// named Freeploy; the labels in the textarea keep Coolify's keys (coolify.*, caddy_*, traefik.*), which
// is what the servers and their proxies read. The listboxes save at once (instantSave); the username,
// the password and hand-written labels are saved with the page's form.
import { Empty, FormInput, FormTextarea, Listbox, ModalConfirmation } from "../components/Coolify";
import type { ApplicationInfo } from "./ApplicationChrome";

/** A listbox change: General::instantSave() with that one field. */
export type InstantSave = (fields: Record<string, unknown>) => void;

interface FieldProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
  disabled: boolean;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** <x-application.settings-subsection id="security-section" title="Authentication" first class="border-b …">. */
export function ApplicationAuthentication({ application, canUpdate, instantSave, username, password }: { application: ApplicationInfo; canUpdate: boolean; instantSave: InstantSave; username: FieldProps; password: FieldProps }) {
  const usesArgon2id = application.httpBasicAuthHashAlgorithm === "argon2id";
  const supportsArgon2id = application.supportsArgon2id === true;
  return (
    <section id="security-section" className="border-b border-neutral-200 py-5 dark:border-white/[0.07]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm! font-semibold! text-black dark:text-fg">Authentication</h3>
      </div>
      {!application.isContainerLabelReadonlyEnabled ? (
        <Empty size="sm" title="Authentication is managed through labels" description="Authentication is managed via manual proxy labels. Switch label management back to Freeploy to configure it here." iconName="admin">
          <button type="button" className="button" onClick={() => document.getElementById("container-labels-section")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Go to Container labels
          </button>
        </Empty>
      ) : (
        <>
          <Listbox
            id="isHttpBasicAuthEnabled"
            label="Method"
            helper="HTTP Basic Authentication adds the required authentication labels to the proxy. Freeploy currently supports a single username and password."
            options={[
              { value: "false", label: "None" },
              { value: "true", label: "HTTP Basic Authentication" },
            ]}
            value={String(application.isHttpBasicAuthEnabled === true)}
            onChange={(v) => instantSave({ isHttpBasicAuthEnabled: v === "true" })}
            disabled={!canUpdate}
          />
          {application.isHttpBasicAuthEnabled ? (
            <>
              <div className="mt-5 grid w-full gap-4 border-t border-neutral-200 pt-5 sm:grid-cols-2 dark:border-white/[0.07]">
                <FormInput {...username} label="Username" required />
                <FormInput {...password} type="password" label="Password" required />
              </div>
              <div className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
                <h3 className="mb-3 text-sm font-semibold text-black dark:text-fg">Password hashing</h3>
                <div className={`grid w-full gap-4 ${usesArgon2id ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                  <Listbox
                    id="httpBasicAuthHashAlgorithm"
                    label="Algorithm"
                    helper={"Algorithm that hashes the password for the proxy labels.\n\nTraefik supports only bcrypt. Argon2id needs the Caddy proxy, version 2.11 or newer. With Argon2id, labels generated for Traefik use bcrypt."}
                    options={[
                      { value: "bcrypt", label: "bcrypt", description: "Works with every proxy" },
                      {
                        value: "argon2id",
                        label: "Argon2id",
                        disabled: !supportsArgon2id,
                        description: supportsArgon2id ? "Memory-hard, more resistant to cracking" : application.proxyType === "CADDY" ? "Needs Caddy 2.11 or newer on this server" : "Only supported by the Caddy proxy",
                      },
                    ]}
                    value={application.httpBasicAuthHashAlgorithm ?? "bcrypt"}
                    onChange={(v) => instantSave({ httpBasicAuthHashAlgorithm: v })}
                    disabled={!canUpdate}
                  />
                  {usesArgon2id ? (
                    <>
                      <div className="min-w-0">
                        <Listbox
                          id="httpBasicAuthArgon2idMemoryCost"
                          label="Memory"
                          helper="Memory that the proxy needs to check a password. More memory makes the hash harder to crack, but every login attempt that the proxy has not seen before uses this much memory on the server."
                          options={[8, 16, 32, 64, 128, 256].map((mebibytes) => ({ value: String(mebibytes * 1024), label: `${mebibytes} MiB` }))}
                          value={String(application.httpBasicAuthArgon2idMemoryCost ?? 65536)}
                          onChange={(v) => instantSave({ httpBasicAuthArgon2idMemoryCost: Number(v) })}
                          disabled={!canUpdate}
                        />
                      </div>
                      <div className="min-w-0">
                        <Listbox
                          id="httpBasicAuthArgon2idTimeCost"
                          label="Iterations"
                          helper="Number of passes over the memory. More iterations make the hash harder to crack and a password check slower."
                          options={range(1, 12).map((iterations) => ({ value: String(iterations), label: String(iterations) }))}
                          value={String(application.httpBasicAuthArgon2idTimeCost ?? 4)}
                          onChange={(v) => instantSave({ httpBasicAuthArgon2idTimeCost: Number(v) })}
                          disabled={!canUpdate}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="min-w-0">
                      <Listbox
                        id="httpBasicAuthBcryptCost"
                        label="Cost factor"
                        helper="Each step doubles the work to check or crack the password. Traefik checks the password on every request, so a higher cost makes every request slower."
                        options={range(4, 14).map((cost) => ({ value: String(cost), label: String(cost) }))}
                        value={String(application.httpBasicAuthBcryptCost ?? 10)}
                        onChange={(v) => instantSave({ httpBasicAuthBcryptCost: Number(v) })}
                        disabled={!canUpdate}
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/** <x-application.settings-subsection id="container-labels-section" title="Labels">. */
export function ApplicationContainerLabels({ application, canUpdate, instantSave, labels, onReset }: { application: ApplicationInfo; canUpdate: boolean; instantSave: InstantSave; labels: FieldProps; onReset: () => Promise<void> }) {
  const readonly = application.isContainerLabelReadonlyEnabled;
  return (
    <section id="container-labels-section" className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm! font-semibold! text-black dark:text-fg">Labels</h3>
      </div>
      <div className="grid w-full gap-4 sm:grid-cols-2">
        <Listbox
          id="isContainerLabelReadonlyEnabled"
          label="Label management"
          helper={
            "When Freeploy manages the labels, they are regenerated automatically and manual edits can be lost.\n\nIf you edit them yourself, be careful: a wrong label set can break the proxy configuration after a restart (you can always reset to the Freeploy defaults)."
          }
          options={[
            { value: "true", label: "Managed by Freeploy (auto-generated)" },
            { value: "false", label: "Managed manually (edit labels yourself)" },
          ]}
          value={String(readonly)}
          onChange={(v) => instantSave({ isContainerLabelReadonlyEnabled: v === "true" })}
          disabled={!canUpdate}
        />
        <Listbox
          id="isContainerLabelEscapeEnabled"
          label="Special characters"
          helper={"By default, $ (and other special characters) are escaped: writing $ saves it as $$.\n\nKeep them unescaped if you want to use environment variables inside the labels."}
          options={[
            { value: "true", label: "Escape special characters ($ becomes $$)" },
            { value: "false", label: "Keep unescaped (allow env variables)" },
          ]}
          value={String(application.isContainerLabelEscapeEnabled)}
          onChange={(v) => instantSave({ isContainerLabelEscapeEnabled: v === "true" })}
          disabled={!canUpdate}
        />
      </div>
      <div className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label className="flex w-fit items-center gap-1.5" style={{ marginBottom: 0 }}>
            Active labels
          </label>
          {canUpdate ? (
            <ModalConfirmation
              title="Confirm Labels Reset to Freeploy Defaults?"
              buttonTitle="Reset to defaults"
              actions={["All your custom proxy labels will be lost.", "Proxy labels (traefik, caddy, etc) will be reset to the freeploy defaults."]}
              confirmationText={`${application.fqdn ?? ""}/`}
              confirmationLabel="Please confirm the execution of the actions by entering the Application URL below"
              shortConfirmationLabel="Application URL"
              step2ButtonText="Permanently Reset Labels"
              onSubmit={onReset}
            />
          ) : null}
        </div>
        <FormTextarea {...labels} rows={15} disabled={readonly || labels.disabled} />
      </div>
    </section>
  );
}
