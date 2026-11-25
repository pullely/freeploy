// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/new/select.blade.php (the
// select-postgresql-type and select-redis-type steps), resources/views/livewire/project/resource/create.blade.php
// (the "Creating …" page) and app/Livewire/Project/{New/Select,Resource/Create}.php (Apache-2.0), modified.
//
// The database steps of the New Resource page: the image of a PostgreSQL or a
// Redis / Valkey database (Select::DATABASE_IMAGE_STEPS, the last step before
// the page reloads with ?database_image=…), and the page that creates the
// database and opens its configuration (Create::createResource()).
import { useEffect, useRef, useState } from "react";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Loading } from "../components/Coolify";
import { databasePath, databasesApi, type DatabaseEngine } from "./DatabaseChrome";

/** DATABASE_TYPES without SQLite: the types POST /databases creates. */
export const DATABASE_TYPES: readonly string[] = ["postgresql", "redis", "mongodb", "mysql", "mariadb", "keydb", "dragonfly", "clickhouse"];
export const isDatabaseType = (type: string | null): type is DatabaseEngine => type !== null && DATABASE_TYPES.includes(type);

interface ImageChoice {
  image: string;
  name: string;
  description: string;
  documentation: string;
  /** The "Default" pill, or PostGIS's "AMD only" note. */
  badge?: "default" | "amd";
}

interface ImageStep {
  title: string;
  description: string;
  choices: ImageChoice[];
}

const POSTGRES = "PostgreSQL is a powerful, open-source object-relational database system (no extensions).";
const PGVECTOR = "PGVector is a PostgreSQL extension for vector data types.";

/** Select::DATABASE_IMAGE_STEPS: the types that ask for an image before the database is created. */
export const DATABASE_IMAGE_STEPS: Readonly<Record<string, ImageStep>> = {
  postgresql: {
    title: "Select a PostgreSQL image",
    description: "Use PostgreSQL 18 unless the workload needs bundled extensions.",
    choices: [
      { image: "postgres:18-alpine", name: "PostgreSQL 18", description: POSTGRES, documentation: "https://hub.docker.com/_/postgres/", badge: "default" },
      { image: "postgres:17-alpine", name: "PostgreSQL 17", description: POSTGRES, documentation: "https://hub.docker.com/_/postgres/" },
      { image: "postgres:16-alpine", name: "PostgreSQL 16", description: POSTGRES, documentation: "https://hub.docker.com/_/postgres/" },
      {
        image: "supabase/postgres:17.11.0.018",
        name: "Supabase PostgreSQL",
        description: "Supabase is a modern, open-source alternative to PostgreSQL with lots of extensions.",
        documentation: "https://github.com/supabase/postgres",
      },
      { image: "postgis/postgis:18-3.7-alpine", name: "PostGIS", description: "PostGIS is a PostgreSQL extension for geographic objects.", documentation: "https://github.com/postgis/docker-postgis", badge: "amd" },
      { image: "pgvector/pgvector:pg18", name: "PGVector 18", description: PGVECTOR, documentation: "https://github.com/pgvector/pgvector" },
      { image: "pgvector/pgvector:pg17", name: "PGVector 17", description: PGVECTOR, documentation: "https://github.com/pgvector/pgvector" },
    ],
  },
  redis: {
    title: "Select a Redis or Valkey image",
    description: "Both work with the same clients, commands, and configuration.",
    choices: [
      {
        image: "valkey/valkey:9-alpine",
        name: "Valkey 9",
        description: "An open-source (BSD) fork of Redis from the Linux Foundation. It works with all Redis clients.",
        documentation: "https://hub.docker.com/r/valkey/valkey/",
        badge: "default",
      },
      { image: "redis:8", name: "Redis 8", description: "The original in-memory key-value store.", documentation: "https://hub.docker.com/_/redis/" },
    ],
  },
};

/** The select-postgresql-type and select-redis-type steps: a card per image; choosing one is setDatabaseImage(). */
export function DatabaseImageStep({ type, onSelect }: { type: string; onSelect: (image: string) => void }) {
  const [selecting, setSelecting] = useState(false);
  const step = DATABASE_IMAGE_STEPS[type];
  if (!step) return null;
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-[15px]! font-semibold!">{step.title}</h2>
        <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">{step.description}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {step.choices.map((choice) => (
          <div
            key={choice.image}
            className={`group relative flex min-h-24 items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-300 dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14] ${selecting ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            onClick={() => {
              if (selecting) return;
              setSelecting(true);
              onSelect(choice.image);
            }}
          >
            <div className="flex flex-col">
              <div className="text-[13px] font-semibold text-black dark:text-fg">
                {choice.name}
                {choice.badge === "default" ? <span className="ml-1 rounded-full bg-coollabs/10 px-2 py-0.5 text-[10px] font-medium text-coollabs dark:bg-brand/15 dark:text-brand-light">Default</span> : null}
                {choice.badge === "amd" ? <span className="ml-1 text-[10px] font-medium text-amber-600 dark:text-amber-300">AMD only</span> : null}
              </div>
              <div className="mt-1 pr-8 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">{choice.description}</div>
            </div>
            <a
              href={choice.documentation}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
              title="View documentation"
            >
              <svg className="w-4 h-4 text-neutral-600 dark:text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

/** str($type)->headline(): "postgresql" reads "Postgresql". */
const headline = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/**
 * create.blade.php's pending page (wire:init="createResource"): the database
 * is created as the page shows, then its configuration opens. A refusal
 * leaves the page with the reason and a way back.
 */
export function CreatingDatabase(props: { orgId: string | undefined; type: DatabaseEngine; projectUuid: string; environmentUuid: string; destination: string; serverUuid: string | null; databaseImage: string | null; back: string }) {
  const started = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { orgId, type, projectUuid, environmentUuid, destination, serverUuid, databaseImage } = props;
  useEffect(() => {
    // Once, also when the effect runs twice (a reload would create a second database).
    if (started.current) return;
    started.current = true;
    void (async () => {
      const r = await postJson<{ uuid: string; projectUuid: string; environmentUuid: string }>(databasesApi(orgId), {
        type,
        project_uuid: projectUuid,
        environment_uuid: environmentUuid,
        destination,
        ...(serverUuid ? { server_id: serverUuid } : {}),
        ...(databaseImage ? { database_image: databaseImage } : {}),
      });
      if (!r.ok) {
        const message = summarize(r.error.messages);
        notify.error(message);
        return setFailed(message);
      }
      window.location.replace(databasePath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
    })();
  }, [orgId, type, projectUuid, environmentUuid, destination, serverUuid, databaseImage]);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center pt-24 text-center">
      <Reicon name="database" className="mb-4 size-8 text-neutral-400 dark:text-fg-faint" />
      <h2 className="empty-state-title">Creating {headline(type)}</h2>
      {failed === null ? (
        <>
          <p className="empty-state-description text-[13px]">Setting up the resource. You will be redirected when it is ready.</p>
          <div className="mt-4">
            <Loading text="Creating..." />
          </div>
        </>
      ) : (
        <>
          <p className="empty-state-description text-[13px]">{failed}</p>
          <a href={props.back} className="button mt-4">
            Back
          </a>
        </>
      )}
    </div>
  );
}
