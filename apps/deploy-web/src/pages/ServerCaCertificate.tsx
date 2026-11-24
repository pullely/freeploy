// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/ca-certificate/show.blade.php,
// resources/views/components/forms/copy-input.blade.php and
// app/Livewire/Server/CaCertificate/Show.php (Apache-2.0), modified.
//
// /server/{uuid}/ca-certificate: the certificate authority that signs the
// database certificates of this server. The certificate can be replaced by one
// made for the same CA key, or regenerated with a new key. The paths in the
// copy are the server's real paths (/data/coolify/…), not brand.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { certificateStatus } from "../lib/certificate";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, CopyButton, FormTextarea, ModalConfirmation, SettingsSection, StatusBadge } from "../components/Coolify";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";

const CA_CERTIFICATE_PATH = "/data/coolify/ssl/coolify-ca.crt";
const BIND_MOUNT = `- ${CA_CERTIFICATE_PATH}:/etc/ssl/certs/coolify-ca.crt:ro`;

interface Page {
  server: ServerInfo;
  certificateContent: string;
  certificateValidUntil: string | null;
  canUpdate: boolean;
}

/** What saving and regenerating answer: Coolify's toast, and the on-server step that is not available yet. */
interface Saved {
  certificateContent: string;
  certificateValidUntil: string | null;
  message: string;
  unavailable: string | null;
}

/** <x-forms.copy-input>. */
function CopyInput({ text }: { text: string }) {
  return (
    <div className="w-full">
      <div className="relative">
        <input
          type="text"
          value={text}
          className="input input-with-copy-button bg-white dark:bg-coolgray-100 dark:read-only:bg-coolgray-100 dark:read-only:text-white"
          readOnly
          onKeyDown={(e) => e.preventDefault()}
          onPaste={(e) => e.preventDefault()}
          onCut={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
          onFocus={(e) => e.target.select()}
        />
        <CopyButton value={text} className="absolute top-1/2 right-2 -translate-y-1/2" />
      </div>
    </div>
  );
}

function ServerCaCertificateContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}/ca-certificate`;
  const [page, setPage] = useState<Page | null>(null);
  const [certificateContent, setCertificateContent] = useState("");
  const [showCertificate, setShowCertificate] = useState(false);

  /** mount() + loadCaCertificate(). */
  const load = useCallback(async () => {
    const r = await getJson<Page>(base);
    if (!r.data) {
      // mount(): a server of another team (or none) redirects to the server list.
      if (r.status === 404) window.location.replace("/servers");
      return;
    }
    setPage(r.data);
    setCertificateContent(r.data.certificateContent);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page) document.title = `${limit(page.server.name, 10)} > CA Certificate | Freeploy`;
  }, [page]);

  /** saveCaCertificate() and regenerateCaCertificate(): the answer's certificate replaces the page's. */
  async function send(path: string, body: unknown, method: "POST" | "PATCH") {
    const r = await postJson<Saved>(base + path, body, method);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    setCertificateContent(r.data.certificateContent);
    setPage((p) => (p ? { ...p, certificateContent: r.data.certificateContent, certificateValidUntil: r.data.certificateValidUntil } : p));
    notify.success(r.data.message);
    if (r.data.unavailable) notify.error(r.data.unavailable);
  }

  if (!page) return null;
  const { server, canUpdate } = page;
  const status = page.certificateValidUntil ? certificateStatus(page.certificateValidUntil) : null;
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="ca-certificate" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        <SettingsSection
          id="server-ca-overview-section"
          title="CA certificate"
          helper="Manage the certificate authority used to sign database certificates on this server."
          actions={status ? <StatusBadge label={status.label} type={status.type} /> : undefined}
        >
          <Callout type="info" title="Using this certificate">
            Mount the CA certificate into containers that connect to databases over SSL. Re-deploy affected databases and resources after replacing or regenerating it.{" "}
            <a className="font-medium underline" href="https://coolify.io/docs/databases/ssl" target="_blank" rel="noreferrer">
              Read the SSL guide.
            </a>
          </Callout>

          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-neutral-500 dark:text-fg-dim">Read-only bind mount</p>
            <CopyInput text={BIND_MOUNT} />
          </div>
        </SettingsSection>

        <SettingsSection
          id="server-ca-content-section"
          title="Certificate content"
          helper="Review or replace the PEM certificate stored on this server."
          actions={
            <div className="flex items-center gap-2">
              <Button onClick={() => setShowCertificate((v) => !v)}>{showCertificate ? "Hide certificate" : "Show certificate"}</Button>
              {canUpdate ? (
                <>
                  <ModalConfirmation
                    title="Confirm changing of CA Certificate?"
                    trigger={
                      <button className="button flex gap-2" type="button">
                        Save certificate
                      </button>
                    }
                    actions={[
                      `This overwrites ${CA_CERTIFICATE_PATH} with your custom certificate.`,
                      "Database certificates on this server will be regenerated and signed with the custom CA.",
                      "You must redeploy affected databases and resources.",
                    ]}
                    confirmationText={CA_CERTIFICATE_PATH}
                    shortConfirmationLabel="CA Certificate Path"
                    step2ButtonText="Confirm"
                    onSubmit={() => send("", { certificateContent }, "PATCH")}
                  />
                  <ModalConfirmation
                    title="Confirm Regenerate Certificate?"
                    trigger={
                      <button className="button flex gap-2" type="button">
                        Regenerate
                      </button>
                    }
                    actions={[
                      "This replaces the current CA certificate with a newly generated certificate.",
                      "Database certificates on this server will be regenerated and signed with the new CA.",
                      "You must redeploy affected databases and resources.",
                    ]}
                    confirmationText={CA_CERTIFICATE_PATH}
                    shortConfirmationLabel="CA Certificate Path"
                    step2ButtonText="Confirm"
                    onSubmit={() => send("/regenerate", {}, "POST")}
                  />
                </>
              ) : null}
            </div>
          }
        >
          {showCertificate ? (
            <FormTextarea
              id="certificateContent"
              rows={15}
              label="PEM certificate"
              placeholder="Paste or edit CA certificate content here…"
              value={certificateContent}
              onChange={setCertificateContent}
              disabled={!canUpdate}
              monospace={false}
            />
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-lg bg-neutral-100/70 px-6 text-center ring-1 ring-neutral-200 dark:bg-black/20 dark:ring-white/[0.08]">
              <Reicon name="keys" className="size-8 text-neutral-300 dark:text-fg-faint" />
              <p className="mt-3 text-sm font-medium text-neutral-950 dark:text-fg">Certificate hidden</p>
              <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">Show the certificate to review or edit its contents.</p>
            </div>
          )}
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerCaCertificatePage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="CA Certificate">
      <ServerCaCertificateContent />
    </Layout>
  );
}
