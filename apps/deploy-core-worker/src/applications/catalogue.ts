// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/Select.php (loadServices: the
// application and database types) (Apache-2.0), modified.
//
// What the New Resource page offers, as Select::loadServices() lists it: the
// names and descriptions are Coolify's, word for word ("Coolify" reads
// "Freeploy"). `logo` is the file under /svgs/ (resource_logo_url() and
// asset()), without its extension. `creatable` is Freeploy's: whether this
// type can be created here yet.

export interface ResourceType {
  id: string;
  name: string;
  description: string;
  documentation?: string;
  logo: string;
  logoDark?: string;
  experimental?: true;
  /** Freeploy can create this type now. */
  creatable: boolean;
}

export const GIT_BASED_APPLICATIONS: readonly ResourceType[] = [
  {
    id: "public",
    name: "Public Git Repository",
    description: "Deploy any public Git repository. Freeploy builds it from source, no credentials required.",
    documentation: "https://coolify.io/docs/applications/ci-cd",
    logo: "resources/public-repo",
    creatable: true,
  },
  {
    id: "private-deploy-key",
    name: "Private Git Repository (with Deploy Key)",
    description: "Deploy a private repository over SSH with a repository-scoped deploy key. Set the URL and branch manually, no automatic deploys.",
    documentation: "https://coolify.io/docs/applications/ci-cd/github/deploy-key",
    logo: "resources/deploy-key",
    creatable: false,
  },
  {
    id: "private-gh-app",
    name: "Git Repository (with GitHub App)",
    description: "Deploy public or private GitHub repositories through a GitHub App, with automatic webhooks and pull request previews.",
    documentation: "https://coolify.io/docs/applications/ci-cd/github/setup-app",
    logo: "resources/github-app",
    logoDark: "resources/github-app-dark",
    creatable: false,
  },
  {
    id: "private-gitlab-app",
    name: "Git Repository (with GitLab App)",
    description: "Deploy public or private GitLab projects through a GitLab App, with automatic webhooks and merge request previews.",
    logo: "resources/gitlab-app",
    creatable: false,
  },
  {
    id: "private-gitea-app",
    name: "Git Repository (with Gitea / Forgejo App)",
    description: "Deploy public or private Gitea, Forgejo, or Codeberg repositories through a Gitea / Forgejo App, with automatic webhooks and pull request previews.",
    logo: "gitea",
    creatable: false,
  },
];

export const DOCKER_BASED_APPLICATIONS: readonly ResourceType[] = [
  {
    id: "dockerfile",
    name: "Dockerfile",
    description: "Deploy an application using a Dockerfile, without a Git repository.",
    documentation: "https://coolify.io/docs/applications/build-packs/dockerfile",
    logo: "resources/dockerfile",
    creatable: true,
  },
  {
    id: "docker-compose-empty",
    name: "Docker Compose",
    description: "Deploy a multi-container application using a Docker Compose file, without a Git repository.",
    documentation: "https://coolify.io/docs/applications/build-packs/docker-compose",
    logo: "resources/docker-compose",
    creatable: false,
  },
  {
    id: "docker-image",
    name: "Docker Image",
    description: "Deploy an application using a prebuilt image from any Docker registry, without a Git repository.",
    documentation: "https://coolify.io/docs/applications",
    logo: "resources/docker-image",
    creatable: true,
  },
];

export const DATABASES: readonly ResourceType[] = [
  { id: "postgresql", name: "PostgreSQL", description: "An extensible relational database with strong SQL support.", logo: "resources/postgres", creatable: true },
  { id: "mysql", name: "MySQL", description: "A relational database for web and general-purpose applications.", logo: "resources/mysql", creatable: true },
  { id: "mariadb", name: "MariaDB", description: "A relational database and drop-in replacement for MySQL.", logo: "resources/mariadb", creatable: true },
  {
    id: "redis",
    name: "Redis / Valkey",
    description: "An in-memory key-value store for caching, queues, and sessions.",
    logo: "resources/redis-valkey",
    logoDark: "resources/redis-valkey-dark",
    creatable: true,
  },
  { id: "keydb", name: "KeyDB", description: "A multithreaded, Redis-compatible in-memory store.", logo: "resources/keydb", logoDark: "resources/keydb-dark", creatable: true },
  {
    id: "dragonfly",
    name: "Dragonfly",
    description: "An in-memory datastore compatible with Redis and Memcached.",
    logo: "resources/dragonfly",
    logoDark: "resources/dragonfly-dark",
    creatable: true,
  },
  { id: "mongodb", name: "MongoDB", description: "A NoSQL database that stores JSON-like documents.", logo: "resources/mongodb", creatable: true },
  { id: "clickhouse", name: "ClickHouse", description: "A column-oriented database for real-time analytics.", logo: "resources/clickhouse", creatable: true },
  {
    id: "sqlite",
    name: "SQLite",
    description: "A lightweight relational database stored in a single file.",
    logo: "resources/sqlite",
    experimental: true,
    creatable: false,
  },
];

/** The types of setType()'s database branch: no Swarm servers are offered for them. */
export const DATABASE_TYPE_IDS: readonly string[] = DATABASES.map((d) => d.id);

/** The type ids Freeploy can create now (the `type` query string of the New Resource page). */
export const CREATABLE_TYPE_IDS: readonly string[] = [...GIT_BASED_APPLICATIONS, ...DOCKER_BASED_APPLICATIONS, ...DATABASES].filter((t) => t.creatable).map((t) => t.id);
