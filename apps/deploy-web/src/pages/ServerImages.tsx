// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/docker-images.blade.php and
// app/Livewire/Server/DockerImages.php (Apache-2.0), modified.
//
// /server/{uuid}/images: the Docker images on the server. load() reads nothing from a server that is not validated,
// so the list is its "No images found" state; reading them from a validated one (`docker image ls`, the disk usage)
// needs the SSH executor, which the error toast says. With no image to list, deleting one is not ported.
import { useCallback, useEffect, useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Empty, SettingsSection } from "../components/Coolify";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";

function ServerImagesContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Images | Freeploy`, []);
  const { me, data, act } = useServerPage<ServerPageData>("images", title);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    await act("images");
    // finally { $this->loaded = true; }
    setLoaded(true);
  }, [act]);
  // wire:init="load"
  useEffect(() => {
    if (data) void load();
  }, [data, load]);
  if (!data) return null;
  const { server, canUpdate } = data;
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="docker-images" canUpdate={canUpdate}>
      <div className="application-settings-form w-full min-w-0">
        <SettingsSection
          id="server-docker-images-section"
          title="Images"
          helper="Docker images stored on this server. Images that no container uses can be deleted here."
          flush
          actions={
            <Button onClick={() => void load()}>
              <Reicon name="refresh" className="size-3.5" />
              Refresh
            </Button>
          }
        >
          <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
            <div className="relative w-full max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                type="search"
                placeholder="Search images by repository, tag or ID"
                aria-label="Search images"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
            </div>
          </div>
          {!loaded ? (
            <div role="status">
              <span className="sr-only">Reading images from the Docker daemon</span>
            </div>
          ) : (
            <div className="p-6">
              <Empty
                size="sm"
                title={search.trim() !== "" ? "No matching images" : "No images found"}
                description={search.trim() !== "" ? "Try another repository, tag or ID, or clear the search." : "Images pulled or built on this server will appear here."}
                iconName="layers"
              />
            </div>
          )}
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerImagesPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Images">
      <ServerImagesContent />
    </Layout>
  );
}
