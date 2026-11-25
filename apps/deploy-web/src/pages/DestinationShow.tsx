// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/destination/show.blade.php and
// app/Livewire/Destination/Show.php (Apache-2.0), modified.
//
// /destination/{uuid} (General: the name; the server's address and the Docker
// network are read-only) and /destination/{uuid}/danger (delete). Deleting a
// standalone destination removes its network on the server first, which needs
// the SSH executor: the API answers that it is not available yet and the
// destination stays. A Swarm destination is deleted.
import { useCallback, useEffect, useState } from "react";
import { Layout } from "../layout/Layout";
import { postJson, summarize } from "../lib/api";
import { takeNotice } from "../lib/flash";
import { notify } from "../lib/toast";
import { Button, DangerZone, FormInput, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { DestinationWorkspace, SwarmDeprecated, useDestination, type DestinationInfo } from "./DestinationChrome";

interface Show {
  destination: DestinationInfo;
  canUpdate: boolean;
}

/** The default destination's network (Server::defaultStandaloneDockerAttributes()): the view does not offer to delete it. */
const DEFAULT_NETWORK = "coolify";

function DestinationShowContent({ danger }: { danger: boolean }) {
  const { base, data, setData } = useDestination<Show>();
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const saved = data?.destination.name;

  useEffect(() => {
    if (saved === undefined) return;
    setName(saved);
    document.title = `${saved} | Destination | Freeploy`;
  }, [saved]);
  // What creating this destination could not do yet (New Destination redirects here).
  useEffect(() => {
    const notice = takeNotice();
    if (notice) notify.error(notice);
  }, []);

  /** Show::submit(): dispatch('success', 'Destination saved.'). */
  const submit = useCallback(async () => {
    setSaving(true);
    const r = await postJson<{ destination: DestinationInfo; message: string }>(base, { name }, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    setData((d) => (d ? { ...d, destination: r.data.destination } : d));
    notify.success(r.data.message);
  }, [base, name, setData]);

  /** Show::delete(): then redirectRoute('destination.index'). */
  async function remove() {
    const r = await postJson<{ deleted: boolean }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/destinations");
  }

  if (!data) return null;
  const { destination, canUpdate } = data;
  const standalone = destination.type === "standalone";
  const subtitle = standalone ? `Docker network on ${destination.server.name || "server"}` : "Deprecated Docker Swarm network";

  return (
    <DestinationWorkspace destination={destination} title={destination.name} subtitle={subtitle} active={danger ? "danger" : "general"}>
      {standalone ? null : <SwarmDeprecated className="mb-6" />}

      {danger ? (
        <div className="application-settings-form">
          <SettingsSection id="destination-danger-section" title="Danger zone" helper="Destructive actions for this destination cannot be undone.">
            <DangerZone
              title="Delete destination"
              action={
                destination.network !== DEFAULT_NETWORK ? (
                  <ModalConfirmation
                    title="Confirm Destination Deletion?"
                    buttonTitle="Delete destination"
                    disabled={!canUpdate}
                    actions={["This permanently deletes the destination and its Docker network."]}
                    confirmationText={destination.name}
                    confirmationLabel="Please confirm by entering the Destination Name below"
                    shortConfirmationLabel="Destination Name"
                    step2ButtonText="Permanently Delete"
                    onSubmit={remove}
                  />
                ) : (
                  <Button error disabled tooltip="The default Freeploy destination cannot be deleted.">
                    Delete destination
                  </Button>
                )
              }
            >
              <p>
                Permanently delete <strong className="font-semibold">{destination.name}</strong> from Freeploy. The Docker network is also removed from the server.
              </p>
              <p>Delete or move every attached resource before deleting this destination.</p>
            </DangerZone>
          </SettingsSection>
        </div>
      ) : (
        <form
          className="application-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <UnsavedBar dirty={canUpdate && name !== destination.name} saving={saving} onSave={() => void submit()} />

          <SettingsSection
            title="General"
            helper={standalone ? "Docker network used to connect deployed resources." : "Deprecated Docker Swarm network."}
            actions={standalone ? undefined : <StatusBadge label="Deprecated" type="warning" />}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput id="name" label="Name" value={name} onChange={setName} disabled={!canUpdate} error={errors.name} />
              <FormInput id="serverIp" label="Server IP" value={destination.server.ip} readOnly />
              {standalone ? (
                <div className="lg:col-span-2">
                  <FormInput id="network" label="Docker network" value={destination.network} readOnly />
                </div>
              ) : null}
            </div>
          </SettingsSection>
        </form>
      )}
    </DestinationWorkspace>
  );
}

export function DestinationShowPage({ danger = false }: { danger?: boolean }) {
  return (
    <Layout title="Destinations" href="/destinations" navHref="/destinations" documentTitle="Destination">
      <DestinationShowContent danger={danger} />
    </Layout>
  );
}
