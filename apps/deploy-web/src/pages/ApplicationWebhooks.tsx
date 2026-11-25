// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/webhooks.blade.php,
// resources/views/components/forms/copy-input.blade.php and app/Livewire/Project/Shared/Webhooks.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/webhooks
// (project.application.webhooks): the deploy webhook and the manual Git
// webhooks with their secrets. The URLs are Coolify's paths on this
// environment's API origin (edgeBase()).
import { useState } from "react";
import { Layout } from "../layout/Layout";
import { edgeBase } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { CopyButton, Empty, FormInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

type Provider = "github" | "gitlab" | "bitbucket" | "gitea";

interface Webhooks {
  deployWebhookPath: string;
  gitBased: boolean;
  manualWebhookPaths: Record<Provider, string | null>;
  gitlabAppWebhookPath: string | null;
  gitWebhook: string | null;
  secrets: Record<string, string | null> | null;
}

type Data = ApplicationSectionData & Webhooks;
type Saved = Webhooks & { message: string };

/** The view's $manualWebhookProviders. */
const PROVIDERS: Array<{ name: string; key: Provider; secret: string; description: string }> = [
  { name: "GitHub", key: "github", secret: "githubManualWebhookSecret", description: "Accepts JSON or form-urlencoded webhook payloads." },
  { name: "GitLab", key: "gitlab", secret: "gitlabManualWebhookSecret", description: "Use the same secret when configuring the webhook in GitLab." },
  { name: "Bitbucket", key: "bitbucket", secret: "bitbucketManualWebhookSecret", description: "Use the same secret when configuring the webhook in Bitbucket." },
  { name: "Gitea", key: "gitea", secret: "giteaManualWebhookSecret", description: "Use the same secret when configuring the webhook in Gitea." },
];

/** <x-forms.copy-input> with its label. */
export function CopyInput({ label, text }: { label: string; text: string }) {
  return (
    <div className="w-full">
      <label className="mb-1 flex items-center gap-1 text-sm font-medium leading-4">{label}</label>
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

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="button" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Reicon name="external-link" className="size-3.5" />
    </a>
  );
}

function ApplicationWebhooksContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("webhooks");
  const [form, setForm] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** $savedSecrets: what the form is compared with; the fields follow it when it changes. */
  const [synced, setSynced] = useState<Webhooks["secrets"] | undefined>(undefined);
  const stored = data?.secrets;
  if (data && synced !== stored) {
    setSynced(stored);
    // generateSecret() keeps the other fields' unsaved edits: only a secret whose stored value changed is replaced.
    setForm(Object.fromEntries(PROVIDERS.map((p) => [p.secret, (synced?.[p.secret] ?? "") === (stored?.[p.secret] ?? "") && form[p.secret] !== undefined ? form[p.secret]! : (stored?.[p.secret] ?? "")])));
  }
  if (!data) return null;
  const { application, canUpdate } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}/webhooks`;
  const origin = edgeBase();
  const url = (path: string | null) => (path === null ? "" : origin + path);
  const dirty = canUpdate && PROVIDERS.some((p) => (form[p.secret] ?? "") !== (stored?.[p.secret] ?? ""));
  const apply = (saved: Saved) => {
    setData({ ...data, ...saved });
    setErrors({});
    showSaved(saved);
  };

  /** Webhooks::submit() */
  async function submit() {
    const r = await patch<Saved>(form);
    if (!r.ok) {
      setErrors(inlineErrors(r.error));
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    apply(r.data);
  }

  /** Webhooks::generateSecret() */
  async function generate(provider: Provider) {
    const r = await sendJson<Saved>("POST", `${base}/${provider}/generate`);
    if (!r.ok) return showError(r.error);
    apply(r.data);
  }

  const manual = data.gitBased && data.manualWebhookPaths.github && data.manualWebhookPaths.gitlab;
  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Webhooks" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div className="flex flex-col gap-6">
        <SettingsSection
          id="deploy-webhook-section"
          title="Deploy webhook"
          helper="Trigger a deployment from an external service. Requests must include a valid Freeploy API authorization token."
        >
          <CopyInput label="Deploy webhook URL" text={url(data.deployWebhookPath)} />
        </SettingsSection>

        {manual ? (
          <form
            className="application-settings-form flex flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
            <SettingsSection
              id="manual-git-webhooks-section"
              title="Manual Git webhooks"
              helper="Configure these endpoints when the repository is not connected through an official Git App."
              flush
              actions={data.gitWebhook ? <ExternalLink href={data.gitWebhook}>Repository settings</ExternalLink> : undefined}
            >
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                {PROVIDERS.map((provider) => (
                  <section key={provider.key} className="px-4 py-5 first:pt-4 last:pb-4">
                    <div className="mb-4">
                      <h4 className="text-sm font-semibold text-black dark:text-fg">{provider.name}</h4>
                      <p className="mt-1 text-[13px] leading-5 text-neutral-500 dark:text-fg-dim">{provider.description}</p>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <CopyInput label="Webhook URL" text={url(data.manualWebhookPaths[provider.key])} />
                      {canUpdate ? (
                        <div className="flex items-end gap-2">
                          <FormInput
                            type="password"
                            id={provider.secret}
                            label="Webhook secret"
                            helper={`Must exactly match the secret configured in ${provider.name}. New secrets need at least 16 characters. Leave empty to disable this webhook.`}
                            value={form[provider.secret] ?? ""}
                            onChange={(value) => setForm({ ...form, [provider.secret]: value })}
                            error={errors[provider.secret]}
                          />
                          <CopyButton value={form[provider.secret] ?? ""} label={`Copy ${provider.name} webhook secret`} />
                          <button type="button" className="button" aria-label={`Generate ${provider.name} webhook secret`} onClick={() => void generate(provider.key)}>
                            Generate
                          </button>
                        </div>
                      ) : (
                        <FormInput disabled label="Webhook secret" value="Hidden (only administrators can view)" />
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </SettingsSection>
          </form>
        ) : data.gitlabAppWebhookPath ? (
          <SettingsSection
            id="manual-git-webhooks-section"
            title="Manual Git webhooks"
            helper="GitLab Apps cannot register repository webhooks, so add this webhook to the GitLab project yourself."
            flush
            actions={data.gitWebhook ? <ExternalLink href={data.gitWebhook}>Repository settings</ExternalLink> : undefined}
          >
            <section className="px-4 py-5">
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-black dark:text-fg">GitLab</h4>
                <p className="mt-1 text-[13px] leading-5 text-neutral-500 dark:text-fg-dim">
                  Add this URL in the GitLab project under Settings → Webhooks. Set the Secret token to the Webhook secret token from the source settings, and enable Push events and Merge request events.
                </p>
              </div>
              <CopyInput label="Webhook URL" text={url(data.gitlabAppWebhookPath)} />
            </section>
          </SettingsSection>
        ) : (
          <SettingsSection id="manual-git-webhooks-section" title="Manual Git webhooks" helper="Manual repository webhooks are only required when a repository is not connected through an official Git App.">
            <Empty size="sm" title="Managed by your Git App" description="This application uses an official Git App, so Freeploy configures repository webhooks automatically." iconName="notifications" />
          </SettingsSection>
        )}
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationWebhooksPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationWebhooksContent />
    </Layout>
  );
}
