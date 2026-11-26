// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/database/configuration.blade.php,
// resources/views/livewire/project/database/{postgresql,redis,mysql,mariadb,mongodb,keydb,dragonfly,clickhouse,sqlite}/general.blade.php,
// resources/views/livewire/project/database/init-script.blade.php, resources/views/components/database-status-info.blade.php
// and app/Livewire/Project/Database/*/General.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/database/{db_uuid}
// (project.database.configuration): the configuration frame and the General
// page of a standalone database, for the nine engines. The nine Blade views
// are one page here: what differs between them — the copy, the credentials,
// the configuration field — is ENGINES below and <Credentials>, word for word
// ("Coolify" reads "Freeploy"). SQLite's (DP-112) has its database files in the
// place of the credentials, and no Access section; its "Connect application"
// part (connect-application.blade.php) is not ported.
// Not here: the "Details" dialog (resource details), the proxy's "View logs"
// dialog, and ClickHouse's "Current data is not in the data volume" warning,
// which Coolify reads from the container on the server.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, CopyButton, Empty, FormInput, FormTextarea, Helper, Listbox, ModalConfirmation, ModalInput, SettingsSection, SettingsSubsection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { databasesApi, databaseUuidFromPath, DatabaseWorkspace, type DatabaseEngine, type DatabaseInfo, type DatabaseShowData, type InitScript } from "./DatabaseChrome";

const HIDDEN_VALUE = "Hidden (only admins can view)";
const ONLY_IN_DATABASE = "You can only change this in the database.";

interface EngineCopy {
  /** "…of this <product> database." */
  product: string;
  imageHelper?: string;
  credentialsHelper: string;
  /** The engine's port: the placeholders of the public port and of the port mappings. */
  port: number;
  containerDescription: string;
  /** The custom configuration field; none for Dragonfly and ClickHouse. */
  configuration?: { field: string; label: string; helper: string; fieldHelper?: string; placeholder?: string };
  /** The engine's credential and configuration properties, in the form. */
  fields: readonly string[];
}

const WITH_CONFIGURATION = "Docker options, configuration, and log forwarding for the database container.";
const WITHOUT_CONFIGURATION = "Docker options and log forwarding for the database container.";
const credentialsOf = (product: string) => `Keep these values aligned with the credentials configured inside ${product}.`;
const plainConfiguration = (field: string, product: string) => ({ field, label: `Custom ${product} configuration`, helper: `Override the ${product} configuration used by this container.` });

const ENGINES: Record<DatabaseEngine, EngineCopy> = {
  postgresql: {
    product: "PostgreSQL",
    imageHelper: "Use a published PostgreSQL image from Docker Hub.",
    credentialsHelper: credentialsOf("PostgreSQL"),
    port: 5432,
    containerDescription: WITH_CONFIGURATION,
    configuration: plainConfiguration("postgresConf", "PostgreSQL"),
    fields: ["postgresUser", "postgresPassword", "postgresDb", "postgresInitdbArgs", "postgresHostAuthMethod", "postgresConf"],
  },
  redis: {
    product: "Redis / Valkey",
    imageHelper: "Use a published Redis or Valkey image from Docker Hub, for example valkey/valkey:9-alpine or redis:8.",
    credentialsHelper: credentialsOf("Redis / Valkey"),
    port: 6379,
    containerDescription: WITH_CONFIGURATION,
    configuration: {
      field: "redisConf",
      label: "Custom Redis / Valkey configuration",
      helper: "Override only the Redis / Valkey directives you need. All other defaults remain active.",
      fieldHelper: "Freeploy automatically applies requirepass using the password above. If you override requirepass here, keep both values identical.",
      placeholder: "# maxmemory 256mb\n    # maxmemory-policy allkeys-lru\n    # timeout 300",
    },
    fields: ["redisUsername", "redisPassword", "redisConf"],
  },
  mysql: {
    product: "MySQL",
    imageHelper: "Use a published MySQL image from Docker Hub.",
    credentialsHelper: credentialsOf("MySQL"),
    port: 3306,
    containerDescription: WITH_CONFIGURATION,
    configuration: plainConfiguration("mysqlConf", "MySQL"),
    fields: ["mysqlRootPassword", "mysqlUser", "mysqlPassword", "mysqlDatabase", "mysqlConf"],
  },
  mariadb: {
    product: "MariaDB",
    imageHelper: "Use a published MariaDB image from Docker Hub.",
    credentialsHelper: credentialsOf("MariaDB"),
    port: 3306,
    containerDescription: WITH_CONFIGURATION,
    configuration: plainConfiguration("mariadbConf", "MariaDB"),
    fields: ["mariadbRootPassword", "mariadbUser", "mariadbPassword", "mariadbDatabase", "mariadbConf"],
  },
  mongodb: {
    product: "MongoDB",
    imageHelper: "Use a published MongoDB image from Docker Hub.",
    credentialsHelper: credentialsOf("MongoDB"),
    port: 27017,
    containerDescription: WITH_CONFIGURATION,
    configuration: plainConfiguration("mongoConf", "MongoDB"),
    fields: ["mongoInitdbRootUsername", "mongoInitdbRootPassword", "mongoInitdbDatabase", "mongoConf"],
  },
  keydb: {
    product: "KeyDB",
    imageHelper: "Use a published eqalpha/keydb image from Docker Hub.",
    credentialsHelper: "Keep this value aligned with the password configured inside KeyDB.",
    port: 6379,
    containerDescription: WITH_CONFIGURATION,
    configuration: {
      field: "keydbConf",
      label: "Custom KeyDB configuration",
      helper: "Override only the KeyDB directives you need. All other defaults remain active.",
      // Coolify's helper is a link with this text; the helper here is plain text.
      fieldHelper: "View the default KeyDB configuration: https://raw.githubusercontent.com/Snapchat/KeyDB/unstable/keydb.conf",
    },
    fields: ["keydbPassword", "keydbConf"],
  },
  dragonfly: {
    product: "Dragonfly",
    credentialsHelper: credentialsOf("Dragonfly"),
    port: 6379,
    containerDescription: WITHOUT_CONFIGURATION,
    fields: ["dragonflyPassword"],
  },
  clickhouse: {
    product: "ClickHouse",
    imageHelper: "Use a published clickhouse/clickhouse-server image from Docker Hub.",
    credentialsHelper: credentialsOf("ClickHouse"),
    port: 8123,
    containerDescription: WITHOUT_CONFIGURATION,
    fields: ["clickhouseAdminUser", "clickhouseAdminPassword"],
  },
  sqlite: {
    product: "SQLite",
    imageHelper: "Use a published peakimages/sqlite image from Docker Hub.",
    credentialsHelper: "",
    // Never reached over TCP: there is no Access section.
    port: 0,
    containerDescription: WITHOUT_CONFIGURATION,
    fields: ["sqliteDatabases"],
  },
};

type Form = Record<string, string>;

function formOf(d: DatabaseInfo): Form {
  const form: Form = {
    name: d.name,
    description: d.description ?? "",
    image: d.image,
    publicPort: d.publicPort === null ? "" : String(d.publicPort),
    publicPortTimeout: d.publicPortTimeout === null ? "" : String(d.publicPortTimeout),
    portsMappings: d.portsMappings ?? "",
    customDockerRunOptions: d.customDockerRunOptions ?? "",
  };
  for (const field of ENGINES[d.engine].fields) form[field] = d.fields[field] ?? "";
  return form;
}

interface Saved {
  database: DatabaseInfo;
  message: string;
  messages?: string[];
}

/** The given props without the undefined ones (an optional prop is left out, not passed as undefined). */
const defined = <T extends Record<string, unknown>>(props: T) => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

type FieldProps = { id: string; value: string; onChange: (v: string) => void; error: string | undefined; disabled: boolean };

/** <x-forms.input disabled value="Hidden (only admins can view)">. */
const HiddenInput = ({ label }: { label: string }) => <FormInput label={label} value={HIDDEN_VALUE} disabled />;

/** <x-callout type="warning" title="Keep credentials synchronized">, shown once the database has started. */
function Synchronized({ product, automations = "backups and other automations" }: { product: string; automations?: string }) {
  return (
    <Callout type="warning" title="Keep credentials synchronized">
      Changing values here does not update {product}. Update {product} first, then synchronize the values here so {automations} continue working.
    </Callout>
  );
}

/** The credentials-section of each engine's view. */
function Credentials({ database, field, hidden }: { database: DatabaseInfo; field: (name: string) => FieldProps; hidden: boolean }) {
  const started = database.startedAt !== null;
  const grid = `${started ? "mt-4 " : ""}grid gap-4 lg:grid-cols-2`;
  const password = (label: string, name: string, props: { required?: boolean; readOnly?: boolean; helper?: string | undefined; disabled?: boolean } = {}, hiddenLabel = label) =>
    hidden ? <HiddenInput label={hiddenLabel} /> : <FormInput {...field(name)} {...(props.disabled ? { disabled: true } : {})} label={label} type="password" required={props.required ?? true} {...defined({ readOnly: props.readOnly, helper: props.helper })} />;
  const initialDatabase = (name: string, placeholder: string, label = "Initial database", required = false) => (
    <FormInput {...field(name)} label={label} placeholder={placeholder} readOnly={started} required={required} {...(started ? { helper: ONLY_IN_DATABASE } : {})} />
  );
  switch (database.engine) {
    case "postgresql":
      return (
        <>
          {started ? <Synchronized product="PostgreSQL" /> : null}
          <div className={grid}>
            <FormInput {...field("postgresUser")} label="Username" placeholder="If empty: postgres" />
            {password("Password", "postgresPassword")}
            {initialDatabase("postgresDb", "If empty, it will match the username.")}
          </div>
        </>
      );
    case "mysql":
    case "mariadb": {
      const p = database.engine;
      return (
        <>
          {started ? <Synchronized product={ENGINES[p].product} /> : null}
          <div className={grid}>
            {password("Root password", `${p}RootPassword`, { required: started })}
            <FormInput {...field(`${p}User`)} label="Normal user" required />
            {password("Normal user password", `${p}Password`)}
            {initialDatabase(`${p}Database`, "If empty, it will match the normal user.")}
          </div>
        </>
      );
    }
    case "mongodb":
      return (
        <>
          {started ? <Synchronized product="MongoDB" /> : null}
          <div className={grid}>
            <FormInput {...field("mongoInitdbRootUsername")} label={started ? "Initial username" : "Username"} placeholder="If empty: root" required={!started} />
            {password(started ? "Initial password" : "Password", "mongoInitdbRootPassword", {}, "Password")}
            {initialDatabase("mongoInitdbDatabase", "If empty, it will match the username.", started ? "Initial database" : "Database", !started)}
          </div>
        </>
      );
    case "redis": {
      const redis = database.redis;
      const sharedHelper = (variable: string) => (started ? ONLY_IN_DATABASE : `Shared ${variable} values make this field read-only.`);
      return (
        <>
          <Callout type="warning" title={started ? "Keep credentials synchronized" : "Verify the initial credentials"}>
            {started ? "Changing values here does not update Redis. Update Redis first, then synchronize the values here so automations continue working." : "These values can only be changed here before the first start."}
          </Callout>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {redis?.hasUsername ? (
              <FormInput {...field("redisUsername")} {...(!started && redis.isUsernameShared ? { disabled: true } : {})} label="Username" required={!started} helper={sharedHelper("REDIS_USERNAME")} />
            ) : null}
            {hidden ? (
              <HiddenInput label="Password" />
            ) : redis?.isPasswordLocked ? (
              <FormInput label="Password" value="Locked (shown once)" disabled helper="REDIS_PASSWORD is locked. Its value is never shown again." />
            ) : (
              password("Password", "redisPassword", { required: !started, helper: sharedHelper("REDIS_PASSWORD"), disabled: !started && redis?.isPasswordShared === true })
            )}
          </div>
        </>
      );
    }
    case "keydb":
    case "dragonfly": {
      const name = `${database.engine}Password`;
      if (started) return password("Password", name, { readOnly: true, helper: ONLY_IN_DATABASE });
      return (
        <>
          <Callout type="warning" title="Verify the initial credentials">
            You can only change this password here before the first start. Later changes must be made inside the database.
          </Callout>
          <div className="mt-4">{password("Password", name)}</div>
        </>
      );
    }
    case "sqlite":
      return null;
    case "clickhouse":
      return (
        <>
          {started ? null : (
            <Callout type="warning" title="Verify the initial credentials">
              You can only change these credentials here before the first start. Later changes must be made inside the database.
            </Callout>
          )}
          <div className={`${started ? "" : "mt-4 "}grid gap-4 lg:grid-cols-2`}>
            <FormInput {...field("clickhouseAdminUser")} label={started ? "Initial username" : "Username"} placeholder="If empty: clickhouse" readOnly={started} required />
            {password(started ? "Initial password" : "Password", "clickhouseAdminPassword", { readOnly: started, helper: started ? ONLY_IN_DATABASE : undefined }, "Password")}
          </div>
        </>
      );
  }
}

/** <x-forms.input type="password" readonly copyable>: a connection URL, masked until peeked, with its copy button. */
function SecretUrl({ label, helper, value }: { label: string; helper: string; value: string }) {
  const [peek, setPeek] = useState(false);
  return (
    <div className="w-full">
      <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
        <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">{label}</label>
        <Helper helper={helper} />
      </div>
      <div className="relative">
        <input autoComplete="off" className={peek ? "input truncate" : "input"} readOnly type={peek ? "text" : "password"} value={value} aria-label={label} />
        <button
          type="button"
          onClick={() => setPeek(!peek)}
          className="password-toggle flex absolute inset-y-0 right-0 z-10 items-center pr-2 cursor-pointer text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
          aria-label="Toggle password visibility"
        >
          <Reicon name={peek ? "eye-off2" : "eye"} className="size-[18px]" />
        </button>
        <CopyButton value={value} className="absolute top-1/2 z-10 -translate-y-1/2 right-8" />
      </div>
    </div>
  );
}

const URL_HELPER = "If you change the user/password/port, this could be different. This is with the default values.";

/** $certificateValidUntil->format('d.m.Y H:i:s') of the stored UTC time. */
function certificateDate(value: string): { text: string; date: Date } {
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date, text: `${p(date.getUTCDate())}.${p(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}` };
}

/** <x-database-status-info>: the connection URLs and the SSL configuration. */
function StatusInfo({ database, canUpdate, onSsl, onRegenerate }: { database: DatabaseInfo; canUpdate: boolean; onSsl: (body: Record<string, unknown>) => void; onRegenerate: () => Promise<void> }) {
  const label = database.urlLabel;
  const ssl = database.ssl;
  const exited = database.status.includes("exited");
  let urls: ReactNode;
  if (database.isPasswordHiddenForMember) {
    urls = (
      <>
        <HiddenInput label={`${label} URL (internal)`} />
        <HiddenInput label={`${label} URL (public)`} />
      </>
    );
  } else if (database.isCredentialLocked) {
    urls = <FormInput label={`${label} URL (internal)`} value="Locked (shown once)" disabled helper="The password variable is locked, so the URL that contains it is not shown." />;
  } else {
    urls = (
      <>
        <SecretUrl label={`${label} URL (internal)`} helper={URL_HELPER} value={database.dbUrl ?? ""} />
        {database.dbUrlPublic ? (
          <SecretUrl label={`${label} URL (public)`} helper={URL_HELPER} value={database.dbUrlPublic} />
        ) : database.showPublicUrlPlaceholder ? (
          <FormInput label={`${label} URL (public)`} helper={URL_HELPER} value="Starting the database will generate this." readOnly />
        ) : null}
      </>
    );
  }
  const certificate = ssl?.enabled && ssl.certificateValidUntil ? certificateDate(ssl.certificateValidUntil) : null;
  const now = Date.now();
  return (
    <div className="space-y-5">
      {urls}
      {ssl ? (
        <div className="border-t border-neutral-200 pt-5 dark:border-white/[0.06]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-black dark:text-fg">SSL configuration</h3>
              <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">Encryption settings can only be changed while the database is stopped.</p>
            </div>
            {certificate && canUpdate ? (
              <ModalConfirmation
                title="Regenerate SSL Certificates"
                buttonTitle="Regenerate SSL Certificates"
                actions={["The SSL certificate of this database will be regenerated.", "You must restart the database after regenerating the certificate to start using the new certificate."]}
                confirmationText={null}
                onSubmit={onRegenerate}
              />
            ) : null}
          </div>
          {certificate ? (
            <div className="mb-4 text-sm text-neutral-600 dark:text-fg-dim">
              Valid until:{" "}
              {now > certificate.date.getTime() ? (
                <span className="text-red-500">{certificate.text} - Expired</span>
              ) : now + 30 * 86_400_000 > certificate.date.getTime() ? (
                <span className="text-red-500">{certificate.text} - Expiring soon</span>
              ) : (
                <span>{certificate.text}</span>
              )}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Listbox
              id="enableSsl"
              label="SSL"
              disabled={!exited || !canUpdate}
              options={[
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
              value={ssl.enabled ? "true" : "false"}
              onChange={(v) => onSsl({ enableSsl: v === "true" })}
            />
            {ssl.modes ? (
              <Listbox id="sslMode" label="SSL mode" {...(ssl.modeHelper ? { helper: ssl.modeHelper } : {})} disabled={!ssl.enabled || !exited || !canUpdate} options={ssl.modes} value={ssl.mode} onChange={(v) => onSsl({ sslMode: v })} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** <livewire:project.database.init-script>: one script's filename and content, with its Delete. */
function InitScriptForm({ script, base, onSaved }: { script: InitScript; base: string; onSaved: (saved: Saved) => void }) {
  const [filename, setFilename] = useState(script.filename);
  const [content, setContent] = useState(script.content);
  const [saving, setSaving] = useState(false);
  const dirty = filename !== script.filename || content !== script.content;
  /** InitScript::submit() → save_init_script */
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    const r = await postJson<Saved>(`${base}/init-scripts`, { originalFilename: script.filename, filename, content }, "PATCH");
    setSaving(false);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    onSaved(r.data);
  }
  /** InitScript::delete() → delete_init_script */
  async function remove() {
    const r = await postJson<Saved>(`${base}/init-scripts?${new URLSearchParams({ filename: script.filename }).toString()}`, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    onSaved(r.data);
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="application-settings-form flex flex-col gap-4 px-4 py-4">
      <div className="flex items-end gap-2">
        <FormInput id={`filename-${script.index}`} label="Filename" value={filename} onChange={setFilename} />
        <ModalConfirmation
          title="Delete initialization script?"
          buttonTitle="Delete"
          actions={["Permanently delete this initialization script from the database and server.", "Redeployments that depend on this script may fail."]}
          confirmationText={script.filename}
          confirmationLabel="Enter the initialization script name to confirm."
          shortConfirmationLabel="Script name"
          step2ButtonText="Permanently delete"
          onSubmit={remove}
        />
      </div>
      <FormTextarea id={`content-${script.index}`} label="Content" rows={12} value={content} onChange={setContent} />
      {dirty ? (
        <div className="flex justify-end">
          <Button type="submit" highlighted disabled={saving}>
            Save changes
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function DatabaseGeneralContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = databaseUuidFromPath();
  const base = `${databasesApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<DatabaseShowData | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newScript, setNewScript] = useState({ new_filename: "", new_content: "" });

  useEffect(() => {
    void (async () => {
      const r = await getJson<DatabaseShowData>(base);
      // Configuration::mount(): the database through its project and environment, or back.
      if (!r.data) {
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      if (r.data.database.project.uuid !== projectUuid || r.data.database.environment.uuid !== environmentUuid) return window.location.replace("/projects");
      setData(r.data);
      setForm(formOf(r.data.database));
      setSaved(formOf(r.data.database));
    })();
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    if (data) document.title = `${limit(data.database.name, 10)} > Configuration | Freeploy`;
  }, [data]);

  /** What a save answers: the database, and the form as it is stored. */
  const refreshed = useCallback((database: DatabaseInfo, keepEdits = false) => {
    setData((d) => (d ? { ...d, database } : d));
    const stored = formOf(database);
    setSaved(stored);
    setForm((f) => (keepEdits && f ? f : stored));
  }, []);

  /** General::submit(): the changed fields, then 'Database updated.'. */
  const submit = useCallback(async () => {
    if (!form || !saved) return;
    const changed = Object.fromEntries(Object.keys(form).filter((f) => form[f] !== saved[f]).map((f) => [f, form[f]]));
    setSaving(true);
    const r = await postJson<Saved>(base, changed, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, messages] of Object.entries(r.error.fields ?? {})) if (messages[0]) inline[f] = messages[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    refreshed(r.data.database);
    notify.success(r.data.message);
  }, [base, form, saved, refreshed]);

  /** instantSave(), instantSaveAdvanced() and instantSaveSSL(): a listbox that saves at once; unsaved edits of the form stay. */
  const instant = useCallback(
    (action: string, body: Record<string, unknown>) => {
      void (async () => {
        const r = await postJson<Saved>(base, { action, ...body }, "PATCH");
        if (!r.ok) return notify.error(summarize(r.error.messages));
        refreshed(r.data.database, true);
        for (const message of r.data.messages ?? [r.data.message]) notify.success(message);
      })();
    },
    [base, refreshed],
  );

  if (!data || !form || !saved) return null;
  const { database, canUpdate } = data;
  const copy = ENGINES[database.engine];
  const sqlite = database.engine === "sqlite";
  const hidden = database.isPasswordHiddenForMember;
  const dirty = Object.keys(form).some((f) => form[f] !== saved[f]);
  const field = (name: string): FieldProps => ({ id: name, value: form[name] ?? "", onChange: (v: string) => setForm({ ...form, [name]: v }), error: errors[name], disabled: !canUpdate });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit();
  };
  const noPort = (form.publicPort ?? "").trim() === "";
  const scriptSaved = (s: Saved) => {
    refreshed(s.database, true);
    notify.success(s.message);
  };
  /** save_new_init_script */
  async function addScript(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<Saved>(`${base}/init-scripts`, newScript);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    scriptSaved(r.data);
    setNewScript({ new_filename: "", new_content: "" });
    setAdding(false);
  }
  /** regenerateSslCertificate */
  async function regenerate() {
    const r = await postJson<Saved>(`${base}/ssl/regenerate`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    scriptSaved(r.data);
  }

  return (
    <DatabaseWorkspace database={database} orgId={me.team?.id} active="General" canUpdate={canUpdate} canManage={data.canManage}>
      <div className="application-settings-form flex flex-col gap-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />

          <SettingsSection
            id="database-details-section"
            title="Database details"
            helper={sqlite ? "Manage the identity, container image, and database files of this SQLite database." : `Manage the identity, container image, and credentials of this ${copy.product} database.`}
            {...(sqlite ? { actions: <StatusBadge label="Experimental" type="warning" /> } : {})}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput {...field("name")} label="Name" />
              <FormInput {...field("description")} label="Description" />
              <div className="lg:col-span-2">
                <FormInput {...field("image")} label="Image" required {...defined({ helper: copy.imageHelper })} />
              </div>
            </div>
            {sqlite ? (
              <SettingsSubsection id="database-files-section" title="Database files" helper="Applications use these databases by mounting the data volume.">
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormInput
                    {...field("sqliteDatabases")}
                    label="File names"
                    placeholder="database.sqlite"
                    required
                    helper="Comma-separated file names. Missing files are created in the data volume on the next start. Removing a name does not delete its file. Backups restore into the first file."
                  />
                </div>
              </SettingsSubsection>
            ) : (
              <SettingsSubsection id="credentials-section" title="Credentials" helper={copy.credentialsHelper}>
                <Credentials database={database} field={field} hidden={hidden} />
              </SettingsSubsection>
            )}
            {database.engine === "postgresql" ? (
              <SettingsSubsection id="initialization-section" title="Initialization" helper="Configure the options used when PostgreSQL creates its initial data directory.">
                <div className="grid gap-4 lg:grid-cols-2">
                  {(
                    [
                      ["postgresInitdbArgs", "Initial database arguments"],
                      ["postgresHostAuthMethod", "Host authentication method"],
                    ] as const
                  ).map(([name, label]) => (
                    <FormInput
                      key={name}
                      {...field(name)}
                      label={label}
                      placeholder="Leave empty to use the image default."
                      helper="Used only on the first start, when PostgreSQL creates the data directory. To apply a change later, delete the data volume or edit the files in the database."
                    />
                  ))}
                </div>
              </SettingsSubsection>
            ) : null}
          </SettingsSection>

          {sqlite ? null : (
            <SettingsSection id="access-section" title="Access" helper="How applications and clients connect to this database, and whether it is reachable from the internet.">
              <SettingsSubsection id="connection-section" title="Connection" helper="Use these URLs to connect to the database." first>
                <StatusInfo database={database} canUpdate={canUpdate} onSsl={(body) => instant("instantSaveSSL", body)} onRegenerate={regenerate} />
              </SettingsSubsection>
              <SettingsSubsection id="public-access-section" title="Public access" helper="Expose this database through the managed TCP proxy.">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <Listbox
                      id="isPublic"
                      label="Access"
                      disabled={!canUpdate}
                      options={[
                        { value: "false", label: "Private" },
                        { value: "true", label: noPort ? "Public through TCP proxy (set public port first)" : "Public through TCP proxy", disabled: noPort },
                      ]}
                      value={database.isPublic ? "true" : "false"}
                      onChange={(v) => instant("instantSave", { isPublic: v === "true", publicPort: form.publicPort, publicPortTimeout: form.publicPortTimeout })}
                    />
                  </div>
                  <FormInput {...field("publicPort")} {...(database.isPublic ? { disabled: true } : {})} type="number" placeholder={String(copy.port)} label="Public port" />
                  <FormInput {...field("publicPortTimeout")} {...(database.isPublic ? { disabled: true } : {})} type="number" placeholder="3600" label="Proxy timeout" helper="Timeout in seconds. The default is 3600." />
                  <FormInput {...field("portsMappings")} placeholder={`3000:${copy.port}`} label="Port mappings" helper={`Comma-separated host-to-container mappings, for example 3000:${copy.port}.`} />
                </div>
              </SettingsSubsection>
            </SettingsSection>
          )}

          <SettingsSection id="container-section" title="Container" helper={copy.containerDescription}>
            {hidden ? (
              <HiddenInput label="Custom Docker options" />
            ) : (
              <FormInput
                {...field("customDockerRunOptions")}
                helper="Add supported docker run options used when the container starts. Unsupported options can interfere with Freeploy automation."
                placeholder="--cap-add SYS_ADMIN --device=/dev/fuse"
                label="Custom Docker options"
              />
            )}
            {copy.configuration ? (
              <SettingsSubsection id="configuration-section" title="Configuration" helper={copy.configuration.helper}>
                {hidden ? (
                  <HiddenInput label={copy.configuration.label} />
                ) : (
                  <FormTextarea {...field(copy.configuration.field)} label={copy.configuration.label} rows={10} {...defined({ placeholder: copy.configuration.placeholder, helper: copy.configuration.fieldHelper })} />
                )}
              </SettingsSubsection>
            ) : null}
            <SettingsSubsection id="log-delivery-section" title="Log delivery" helper="Forward container logs to the drain configured on the server.">
              <Listbox
                id="isLogDrainEnabled"
                label="Log drain"
                disabled={!canUpdate}
                options={[
                  { value: "false", label: "Do not forward logs" },
                  { value: "true", label: "Forward logs to the server drain" },
                ]}
                value={database.isLogDrainEnabled ? "true" : "false"}
                onChange={(v) => instant("instantSaveAdvanced", { isLogDrainEnabled: v === "true" })}
              />
            </SettingsSubsection>
          </SettingsSection>
        </form>

        {database.engine === "postgresql" ? (
          <SettingsSection
            id="initialization-scripts-section"
            title="Initialization scripts"
            helper="Run SQL files in order when PostgreSQL initializes for the first time."
            flush
            actions={
              canUpdate ? (
                <ModalInput title="New initialization script" open={adding} onOpenChange={setAdding} trigger={<Button onClick={() => setAdding(true)}>+ Add</Button>}>
                  <form className="flex w-full flex-col gap-4" onSubmit={(e) => void addScript(e)}>
                    <FormInput id="new_filename" placeholder="create_test_db.sql" label="Filename" required value={newScript.new_filename} onChange={(v) => setNewScript({ ...newScript, new_filename: v })} />
                    <FormTextarea id="new_content" rows={16} placeholder="CREATE DATABASE test;" label="Content" required value={newScript.new_content} onChange={(v) => setNewScript({ ...newScript, new_content: v })} />
                    <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
                      <Button type="submit">Add script</Button>
                    </div>
                  </form>
                </ModalInput>
              ) : undefined
            }
          >
            <div className="divide-y divide-neutral-200 dark:divide-border-subtle">
              {hidden ? (
                <Empty title={HIDDEN_VALUE} description="Initialization scripts can contain credentials." />
              ) : (database.initScripts ?? []).length ? (
                (database.initScripts ?? []).map((script) => <InitScriptForm key={script.filename} script={script} base={base} onSaved={scriptSaved} />)
              ) : (
                <Empty title="No initialization scripts" description="Add a SQL file to run during the first PostgreSQL initialization." />
              )}
            </div>
          </SettingsSection>
        ) : null}
      </div>
    </DatabaseWorkspace>
  );
}

export function DatabaseGeneralPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <DatabaseGeneralContent />
    </Layout>
  );
}
