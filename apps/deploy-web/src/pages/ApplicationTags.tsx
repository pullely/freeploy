// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/tags.blade.php and
// app/Livewire/Project/Shared/Tags.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/tags
// (project.application.tags): the application's tags. A tag belongs to the
// team; here it is added to and removed from this application. The same
// component is a database's Tags page (TagsContent with kind "database").
import { useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, DangerCallout, Empty, FormInput, SettingsSection } from "../components/Coolify";
import { resourceApi, resourceFrame, useResourceSection, type ResourceKind, type ResourceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface Tag {
  id: string;
  name: string;
}

interface Tags {
  tags: Tag[];
  availableTags: Tag[];
}

type Data = ResourceSectionData & Tags;
type Saved = Tags & { message: string | null; errors: Array<{ title: string; description: string }> };

/** <livewire:project.shared.tags :resource>: an application's or a database's tags. */
export function TagsContent({ kind }: { kind: ResourceKind }) {
  const { me, data, setData } = useResourceSection<Data>(kind, "tags");
  const [newTags, setNewTags] = useState("");
  const [error, setError] = useState<string | undefined>();
  if (!data) return null;
  const { canUpdate } = data;
  const base = `${resourceApi(kind, me.team?.id, resourceFrame(data).uuid)}/tags`;

  /** Tags::refresh(): the lists again, and the field emptied. */
  async function send(method: "POST" | "DELETE", path: string, body?: Record<string, unknown>) {
    const r = await sendJson<Saved>(method, base + path, body);
    if (!r.ok) {
      setError(r.error.fields.newTags?.[0]);
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    setError(undefined);
    setData({ ...data!, tags: r.data.tags, availableTags: r.data.availableTags });
    setNewTags("");
    // submit(): one error toast per name that was not added.
    for (const e of r.data.errors) toast(e.title, { type: "danger", description: e.description });
    showSaved(r.data);
  }

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Tags">
      <div className="flex flex-col gap-6">
        <SettingsSection id="tag-assignment-section" title="Tags" helper="Organize this resource with reusable team tags. Separate multiple tag names with spaces.">
          {canUpdate ? (
            <form
              className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                void send("POST", "", { newTags });
              }}
            >
              <FormInput id="newTags" label="Tag names" helper="Existing tags are assigned automatically. New names create team tags." placeholder="production api customer-a" value={newTags} onChange={setNewTags} error={error} />
              <Button type="submit" highlighted>
                <Reicon name="plus" className="size-3.5" />
                Add tags
              </Button>
            </form>
          ) : (
            <DangerCallout title="Insufficient permissions" className="">
              You do not have permission to manage tags for this resource.
            </DangerCallout>
          )}
        </SettingsSection>

        <SettingsSection id="assigned-tags-section" title="Assigned tags" helper="Tags currently attached to this resource." flush>
          {data.tags.length ? (
            data.tags.map((tag) => (
              <div key={tag.id} className="flex min-h-12 items-center gap-3 border-b border-neutral-200 px-4 py-2.5 last:border-b-0 dark:border-white/[0.07]">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]">
                  <Reicon name="tags" className="size-4" />
                </div>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-black dark:text-fg">{tag.name}</span>
                {canUpdate ? (
                  <Button error className="h-7!" onClick={() => void send("DELETE", `/${tag.id}`)}>
                    Remove
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <Empty size="sm" title="No tags assigned" description="Add a tag above or select one from your team's available tags." iconName="tags" />
          )}
        </SettingsSection>

        {canUpdate && data.availableTags.length > 0 ? (
          <SettingsSection id="available-tags-section" title="Available tags" helper="Assign an existing team tag with one click.">
            <div className="flex flex-wrap gap-2">
              {data.availableTags.map((tag) => (
                <Button key={tag.id} onClick={() => void send("POST", `/${tag.id}`)}>
                  <Reicon name="plus" className="size-3.5 text-coollabs dark:text-brand-light" />
                  {tag.name}
                </Button>
              ))}
            </div>
          </SettingsSection>
        ) : null}
      </div>
    </ResourceWorkspace>
  );
}

export function ApplicationTagsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <TagsContent kind="application" />
    </Layout>
  );
}
