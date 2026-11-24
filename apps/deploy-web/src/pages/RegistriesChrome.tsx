// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/docker-registries/{login,server-registries,used-by-item}.blade.php
// and app/Livewire/Server/DockerRegistries/{Login,ServerRegistries}.php (Apache-2.0), modified.
//
// What the registries overview and a server's Registries page share: a
// server's registries card and the login form. Coolify keeps a login only in
// the Docker config on the server, and reading it, docker login and docker
// logout need the SSH executor: until it is deployed a card lists the
// registries the server's resources use, its error line says why the logins
// are not shown, and Log in answers that it is not available yet.
//
// Not ported: the actions menu of a row logged in through `auths` (Test, Edit
// and Delete in <x-table.row-actions>) — no row can read as logged in before
// the executor; such a row shows the Test button of a credential helper's row.
import { useState, type FormEvent } from "react";
import { useSignedIn } from "../layout/Layout";
import { postJson } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { FormInput, FormTextarea, Listbox, ModalInput, StatusBadge } from "../components/Coolify";

/** Login::PROVIDERS, as the API sends them. */
export interface RegistryProvider {
  value: string;
  label: string;
  registry: string;
  username: string;
  placeholder: string;
  hint: string;
  hostPattern: string | null;
}

interface RegistryUser {
  type: string;
  name: string;
  link: string | null;
}

export interface RegistryRow {
  registry: string;
  logged_in: boolean;
  source: "auths" | "credHelpers" | null;
  username: string | null;
  used_by: RegistryUser[];
}

/** ServerRegistries: one server's card. */
export interface RegistriesCard {
  uuid: string;
  name: string;
  isFunctional: boolean;
  registries: RegistryRow[];
  error: string | null;
}

const CUSTOM: RegistryProvider = { value: "custom", label: "Other", registry: "", username: "", placeholder: "registry.example.com", hint: "", hostPattern: null };

/** Login::providerFor(): the first provider whose host, or host pattern, the registry matches. */
export function providerFor(providers: RegistryProvider[], registry: string): string {
  return providers.find((p) => p.registry === registry || (p.hostPattern !== null && new RegExp(p.hostPattern).test(registry)))?.value ?? "custom";
}

/** Str::plural() for the four kinds of user: Application, Database, Service, Build. */
const plural = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

/**
 * livewire/server/docker-registries/login: the provider, the registry and the
 * credentials; on the overview (no card server) also the servers to log in to.
 * `preset` is a row's registry (Log in on a row).
 */
export function RegistryLoginForm(props: { server: { uuid: string; name: string } | null; servers?: Array<{ uuid: string; name: string }>; providers: RegistryProvider[]; preset?: string; onDone: () => void }) {
  const { me } = useSignedIn();
  const preset = (value: string) => props.providers.find((p) => p.value === value) ?? CUSTOM;
  const initial = props.preset === undefined ? "custom" : providerFor(props.providers, props.preset);
  const [provider, setProvider] = useState(initial);
  const [registry, setRegistry] = useState(props.preset ?? "");
  const [username, setUsername] = useState(props.preset === undefined ? "" : preset(initial).username);
  const [password, setPassword] = useState("");
  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const current = preset(provider);
  const serverOptions = props.servers ?? [];

  /** updatedProvider(): the provider's host and username; the password is cleared. */
  function changeProvider(value: string) {
    setProvider(value);
    setRegistry(preset(value).registry);
    setUsername(preset(value).username);
    setPassword("");
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const org = `/v1/organizations/${me.team?.id ?? ""}/deploy`;
    const body = { provider, registry, username, password };
    const r = props.server
      ? await postJson<{ message: string }>(`${org}/servers/${encodeURIComponent(props.server.uuid)}/registries`, body)
      : await postJson<{ message: string }>(`${org}/registries`, { ...body, selectedServers });
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) {
        // $this->password = ''; dispatch('error', 'Login failed.', $details)
        setPassword("");
        toast("Login failed.", { type: "danger", description: r.error.messages.join(" ") });
      }
      return;
    }
    setErrors({});
    notify.success(r.data.message);
    props.onDone();
  }

  return (
    <div>
      <form className="flex flex-col gap-3" onSubmit={(e) => void login(e)}>
        {props.server === null ? (
          <Listbox
            id="selectedServers"
            label="Servers"
            required
            searchable
            placeholder={serverOptions.length === 0 ? "No reachable server to log in to" : "Select servers"}
            searchPlaceholder="Search servers…"
            disabled={serverOptions.length === 0}
            options={serverOptions.map((s) => ({ value: s.uuid, label: s.name }))}
            value={null}
            onChange={() => undefined}
            values={selectedServers}
            onValues={setSelectedServers}
            error={errors.selectedServers}
          />
        ) : null}
        <Listbox id="provider" label="Provider" options={props.providers.map((p) => ({ value: p.value, label: p.label }))} value={provider} onChange={changeProvider} />
        {current.hint ? <p className="text-[12px] text-neutral-500 dark:text-fg-dim">{current.hint}</p> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <FormInput id="registry" label="Registry" required placeholder={current.placeholder} readOnly={current.registry !== ""} value={registry} onChange={setRegistry} error={errors.registry} />
          <FormInput id="username" label="Username" required value={username} onChange={setUsername} error={errors.username} />
        </div>
        {provider === "google" ? (
          <FormTextarea key="registry-password-json" id="password" label="Service account JSON key" rows={6} required value={password} onChange={setPassword} error={errors.password} />
        ) : (
          <FormInput key="registry-password-token" id="password" type="password" label="Password or token" required value={password} onChange={setPassword} error={errors.password} />
        )}
        <p className="text-[12px] text-neutral-500 dark:text-fg-dim">
          Freeploy does not save the token. Docker saves the login on the server in <code>~/.docker/config.json</code>, encoded but not encrypted.
        </p>
        <div className="flex justify-end">
          <button type="submit" className="button button-highlighted" disabled={saving}>
            Log in
          </button>
        </div>
      </form>
    </div>
  );
}

/** livewire/server/docker-registries/used-by-item. */
function UsedByItem({ user, withType = true }: { user: RegistryUser; withType?: boolean }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline gap-1">
      {user.link ? (
        <a href={user.link} className="truncate hover:underline">
          {user.name}
        </a>
      ) : (
        <span className="truncate">{user.name}</span>
      )}
      {withType ? <span className="shrink-0 text-[11px] text-neutral-400 dark:text-fg-faint">{user.type}</span> : null}
    </span>
  );
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_4.5rem]";

function RegistryRowView({ card, row, providers, onChanged }: { card: RegistriesCard; row: RegistryRow; providers: RegistryProvider[]; onChanged: () => void }) {
  const { me } = useSignedIn();
  const [showUsers, setShowUsers] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const usedByCount = row.used_by.length;
  // countBy('type') and groupBy('type'): the types in the order of their first user.
  const groups = new Map<string, RegistryUser[]>();
  for (const user of row.used_by) groups.set(user.type, [...(groups.get(user.type) ?? []), user]);
  const usedBySummary = [...groups].map(([type, users]) => `${users.length} ${plural(type.toLowerCase(), users.length)}`).join(" · ");
  const isHub = row.registry === "docker.io";

  /** testLogin(): docker login with the saved credentials. */
  async function testLogin() {
    setTesting(true);
    const r = await postJson<{ message: string }>(`/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(card.uuid)}/registries/${encodeURIComponent(row.registry)}/check`, {});
    setTesting(false);
    if (r.ok) {
      setCheck({ ok: true, message: "The login works." });
      notify.success(r.data.message);
      return;
    }
    const message = r.error.messages.join(" ");
    // Not available yet (501) says nothing about the login itself.
    if (r.error.status !== 501) setCheck({ ok: false, message });
    toast(`The login for ${row.registry} does not work.`, { type: "danger", description: message });
  }

  let status;
  if (row.logged_in && check?.ok === false) status = <StatusBadge type="error" label="Login failed" title={check.message} />;
  else if (row.logged_in) status = <StatusBadge type="success" label={row.source === "credHelpers" ? "Credential helper" : "Logged in"} />;
  else if (card.error) status = <StatusBadge label="Unknown" />;
  else status = <StatusBadge type={isHub ? "neutral" : "warning"} label="Not logged in" title={isHub ? "Public Docker Hub images do not need a login." : null} />;

  let actions = null;
  if (row.logged_in) {
    actions = (
      <button type="button" onClick={() => void testLogin()} disabled={testing} className="button w-fit" title="Run docker login with the saved credentials">
        Test
      </button>
    );
  } else if (!card.error && card.isFunctional) {
    actions = (
      <ModalInput
        title={`Log in to ${row.registry}`}
        subtitle={`Runs docker login on ${card.name}.`}
        open={loginOpen}
        onOpenChange={setLoginOpen}
        trigger={
          <button type="button" className="button">
            Log in
          </button>
        }
      >
        <RegistryLoginForm
          server={card}
          providers={providers}
          preset={row.registry}
          onDone={() => {
            setLoginOpen(false);
            onChanged();
          }}
        />
      </ModalInput>
    );
  }

  return (
    <div className="min-w-[760px] border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
      <div className={`grid min-h-11 ${COLUMNS} items-center px-4 py-2 text-[12px]`}>
        <div className="truncate font-mono">{row.registry}</div>
        <div>{status}</div>
        <div className="min-w-0 text-neutral-600 dark:text-fg-dim">
          {usedByCount === 0 ? (
            <span className="text-neutral-400 dark:text-fg-faint">-</span>
          ) : usedByCount === 1 ? (
            <UsedByItem user={row.used_by[0]!} />
          ) : (
            <button type="button" onClick={() => setShowUsers(!showUsers)} aria-expanded={showUsers} className="inline-flex max-w-full items-center gap-1 hover:text-black dark:hover:text-fg">
              <span className="truncate">{usedBySummary}</span>
              <Reicon name="chevron-down" className={`size-3 shrink-0 transition-transform${showUsers ? " rotate-180" : ""}`} />
            </button>
          )}
        </div>
        <div className="flex justify-end">{actions}</div>
      </div>
      {usedByCount > 1 && showUsers ? (
        <div className="grid gap-x-6 gap-y-3 bg-neutral-50 px-4 py-3 text-[12px] sm:grid-cols-3 dark:bg-white/[0.02]">
          {[...groups].map(([type, users]) => (
            <div key={type} className="min-w-0">
              <p className="mb-1 text-[11px] font-medium text-neutral-500 dark:text-fg-faint">
                {plural(type, 2)} ({users.length})
              </p>
              <ul className="flex flex-col gap-0.5 text-neutral-600 dark:text-fg-dim">
                {users.map((user, i) => (
                  <li key={i} className="truncate">
                    <UsedByItem user={user} withType={false} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * livewire/server/docker-registries/server-registries: a server's registries —
 * the ones it is logged in to and the ones its resources use. Refresh reads
 * the card again (loadRegistries).
 */
export function ServerRegistriesCard({ card, providers, onRefresh }: { card: RegistriesCard; providers: RegistryProvider[]; onRefresh: () => Promise<void> }) {
  const [newOpen, setNewOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Public Docker Hub images need no login, so an unused Docker Hub row would only add noise.
  const dockerHubRow = card.registries.find((row) => row.registry === "docker.io" && !row.logged_in);
  const visibleRows = card.registries.filter((row) => row !== dockerHubRow);

  async function refresh() {
    setLoading(true);
    await onRefresh();
    setLoading(false);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
      <div className="flex items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.05]">
        <Reicon name="servers" className="size-4 shrink-0 text-neutral-500 dark:text-fg-dim" />
        <a href={`/server/${card.uuid}`} className="min-w-0 truncate text-[13px] font-semibold text-black hover:underline dark:text-fg">
          {card.name}
        </a>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => void refresh()} disabled={loading} className="button w-fit">
            <Reicon name="refresh" className="size-3.5" />
            Refresh
          </button>
          {card.isFunctional ? (
            <ModalInput
              title="Log in to a registry"
              subtitle={`Runs docker login on ${card.name}.`}
              open={newOpen}
              onOpenChange={setNewOpen}
              trigger={
                <button type="button" className="button">
                  New
                </button>
              }
            >
              <RegistryLoginForm
                server={card}
                providers={providers}
                onDone={() => {
                  setNewOpen(false);
                  void onRefresh();
                }}
              />
            </ModalInput>
          ) : null}
        </div>
      </div>

      {card.error ? <div className="px-4 py-3 text-[12px] text-red-700 dark:text-red-300">{card.error}</div> : null}

      {visibleRows.length === 0 ? (
        card.error ? null : (
          <div className="px-4 py-3 text-[12px] text-neutral-500 dark:text-fg-faint">Not logged in to any registry, and no resource on this server uses a private registry host.</div>
        )
      ) : (
        <div className="overflow-x-auto">
          <div className={`grid min-w-[760px] ${COLUMNS} border-b border-neutral-200 px-4 py-2 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint`}>
            <div>Registry</div>
            <div>Status</div>
            <div>Used by</div>
            <div className="text-right">Actions</div>
          </div>
          {visibleRows.map((row) => (
            <RegistryRowView key={`${card.uuid}-${row.registry}`} card={card} row={row} providers={providers} onChanged={() => void onRefresh()} />
          ))}
        </div>
      )}

      {dockerHubRow && !card.error ? (
        <div className="border-t border-neutral-200 px-4 py-2.5 text-[12px] text-neutral-500 dark:border-white/[0.07] dark:text-fg-faint">
          {dockerHubRow.used_by.length === 1 ? "1 resource on this server uses" : `${dockerHubRow.used_by.length} resources on this server use`} Docker Hub images. Public images need no login. Log in to Docker Hub for private images or
          higher pull limits.
        </div>
      ) : null}
    </div>
  );
}
