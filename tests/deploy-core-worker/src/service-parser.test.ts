// The service Compose parser (DP-59) against Coolify's own PHP. fixtures/services/goldens.json.gz is what
// coollabsio/coolify@91b7e3e does with every template of the catalogue: the service created as
// Resource/Create.php creates it, parsed (`first`), and parsed once more (`second`) — the rows of the
// service, its applications and databases, its environment variables and its volumes, and the Compose file
// it would deploy (emit.php, see the README there). The TypeScript parser, on an in-memory store, must
// arrive at the same rows and the same bytes for every template.
//
// What PHP draws at random cannot be seeded there, so it is replayed here: the value of each generated
// magic variable (SERVICE_PASSWORD_*, SERVICE_USER_*, SERVICE_BASE64_*, SERVICE_HEX_*, SERVICE_REALBASE64_*)
// is handed to the parser from the golden, after its shape is checked against what the port itself would
// generate. The two Supabase JWTs are NOT replayed: the port signs them, at the emitter's fixed time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PhpArray } from "@deploy-core-worker/compose/php";
import { generateEnvValue, hmacSha256, sha256, supabaseJwt } from "@deploy-core-worker/services/magic-values";
import { applyServiceApplicationPrerequisites, createServiceFromTemplate, newServiceFromTemplate, parseService, type ServiceParserContext } from "@deploy-core-worker/services/parser";
import { MemoryServiceStore } from "@deploy-core-worker/services/store";
import { asGolden, contextFor, difference, NOW, RANDOM_SHAPES, source, type Goldens } from "./service-golden-rows";


// Jest runs from tests/deploy-core-worker (its rootDir).
const goldens = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), "fixtures", "services", "goldens.json.gz"))).toString("utf8")) as Goldens;
const fixture = goldens.fixture;

interface Comparison {
  different: string[];
  shapeErrors: string[];
  totals: { services: number; applications: number; databases: number; variables: number; persistentVolumes: number; fileVolumes: number; reparsedDifferently: number };
}

/** Every service of a golden file: created, parsed and parsed again, each time compared with PHP's rows and bytes. */
function compare(file: Goldens): Comparison {
  const different: string[] = [];
  const shapeErrors: string[] = [];
  const totals = { services: 0, applications: 0, databases: 0, variables: 0, persistentVolumes: 0, fileVolumes: 0, reparsedDifferently: 0 };
  for (const [name, golden] of Object.entries(file.services)) {
    if (!golden.ok) {
      different.push(`${name}: PHP answered ${golden.error}`);
      continue;
    }
    try {
      const created = newServiceFromTemplate({ type: `one-click-service-${name}`, uuid: file.fixture.service_uuid });
      if (!created) throw new Error("not in the shipped catalogue");
      const store = MemoryServiceStore.forService(created.service);
      createServiceFromTemplate(store, created.environment, contextFor(file.fixture, golden.first, shapeErrors));
      const first = difference(asGolden(store.rows()), golden.first);
      if (first !== null) {
        different.push(`${name} (first parse): ${first}`);
        continue;
      }
      const expected = golden.second === "same" ? golden.first : golden.second;
      parseService(store, contextFor(file.fixture, expected, shapeErrors));
      const second = difference(asGolden(store.rows()), expected);
      if (second !== null) different.push(`${name} (second parse): ${second}`);
      if (golden.second !== "same") totals.reparsedDifferently += 1;
      totals.services += 1;
      totals.applications += golden.first.applications.length;
      totals.databases += golden.first.databases.length;
      totals.variables += golden.first.environment_variables.length;
      totals.persistentVolumes += golden.first.persistent_volumes.length;
      totals.fileVolumes += golden.first.file_volumes.length;
    } catch (error) {
      different.push(`${name}: threw ${String(error)}`);
    }
  }
  return { different, shapeErrors, totals };
}

describe("the service parser against Coolify's serviceParser, for every template of the catalogue", () => {
  const names = Object.keys(goldens.services);

  it("has a golden for all 359 templates, none of which PHP failed to parse", () => {
    expect(names).toHaveLength(359);
    expect(names.filter((name) => !goldens.services[name]?.ok)).toEqual([]);
    expect(fixture.coolify_version).toBe("4.7.6");
    expect(fixture.base_configuration_dir).toBe("/data/coolify");
    expect(fixture.server).toMatchObject({ wildcard_domain: null, proxy_type: null, generate_exact_labels: false, is_log_drain_enabled: false });
  });

  it("creates each service and parses it twice with PHP's rows and PHP's bytes", () => {
    const result = compare(goldens);
    expect(result.shapeErrors).toEqual([]);
    expect(result.different).toEqual([]);
    // What the comparison covered.
    expect(result.totals).toEqual({ services: 359, applications: 573, databases: 219, variables: 5849, persistentVolumes: 791, fileVolumes: 125, reparsedDifferently: 4 });
  });
});

describe("the service parser on other servers, for a selection of templates", () => {
  // The same emitter with --variant: the proxy chosen, "generate exact labels" on, and a wildcard domain.
  const variants = [
    ["traefik-exact", { proxy_type: "TRAEFIK", generate_exact_labels: true, wildcard_domain: "https://apps.example.com" }],
    ["caddy-exact", { proxy_type: "CADDY", generate_exact_labels: true, wildcard_domain: "http://example.org" }],
  ] as const;

  it.each(variants)("%s: only that proxy's labels, domains below the wildcard domain", (variant, server) => {
    const file = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), "fixtures", "services", `goldens-${variant}.json.gz`))).toString("utf8")) as Goldens;
    expect(file.fixture.server).toMatchObject(server);
    const result = compare(file);
    expect(result.shapeErrors).toEqual([]);
    expect(result.different).toEqual([]);
    expect(result.totals.services).toBe(34);
    const compose = file.services.umami?.ok ? String(file.services.umami.first.service.docker_compose) : "";
    expect(compose.includes("traefik.http.routers")).toBe(variant === "traefik-exact");
    expect(compose.includes("caddy_0.")).toBe(variant === "caddy-exact");
  });
});

describe("the magic values", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  it("hashes as SHA-256 and HMAC-SHA-256 do", () => {
    expect(hex(sha256(bytes("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(bytes("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(bytes("a".repeat(200))))).toBe("c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
    // RFC 4231, test case 2.
    expect(hex(hmacSha256(bytes("Jefe"), bytes("what do ya want for nothing?")))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("signs the Supabase keys as PHP did", () => {
    const supabase = goldens.services.supabase;
    if (!supabase?.ok) throw new Error("no golden for supabase");
    const value = (key: string) => supabase.first.environment_variables.find((row) => row.key === key)?.value as string;
    expect(supabaseJwt(value("SERVICE_PASSWORD_JWT"), "anon", NOW)).toBe(value("SERVICE_SUPABASEANON_KEY"));
    expect(supabaseJwt(value("SERVICE_PASSWORD_JWT"), "service_role", NOW + 59)).toBe(value("SERVICE_SUPABASESERVICE_KEY"));
  });

  it("generates each command in Coolify's shape, and nothing for a command it does not know", () => {
    for (const [command, shape] of Object.entries(RANDOM_SHAPES)) expect(generateEnvValue(command, source)).toMatch(shape);
    expect(generateEnvValue("API", source)).toBeNull();
    expect(generateEnvValue("", source)).toBeNull();
    expect(generateEnvValue("SUPABASEANON", source, null)).toBeNull();
    const password = generateEnvValue("PASSWORDWITHSYMBOLS", source) ?? "";
    expect(/[A-Za-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)).toBe(true);
  });
});

describe("the parser outside the catalogue", () => {
  const context: ServiceParserContext = contextFor(fixture, { service: {}, applications: [], databases: [], environment_variables: [], persistent_volumes: [], file_volumes: [] }, []);
  const service = (compose: string) =>
    MemoryServiceStore.forService({ id: 1, uuid: "svc", name: "custom-svc", docker_compose_raw: compose, docker_compose: null, connect_to_docker_network: false, service_type: null, is_container_label_escape_enabled: true, compose_parsing_version: "5", include_coolify_default_variables: true });

  it("returns nothing for a file it cannot read, and leaves the service as it is", () => {
    const store = service("services: [\n");
    expect(parseService(store, context).compose).toEqual(new PhpArray());
    expect(store.rows().service.docker_compose).toBeNull();
    expect(parseService(service(""), context).compose.size).toBe(0);
  });

  it("refuses what Coolify refuses", () => {
    expect(() => parseService(service("services:\n  'a;b':\n    image: nginx\n"), context)).toThrow("Invalid Docker Compose service name");
    expect(() => parseService(service("services:\n  _a:\n    image: nginx\n"), context)).toThrow("must start with a letter or a digit");
    expect(() => parseService(service("services:\n  a:\n    image: nginx\n    scale: 2\n"), context)).toThrow("sets scale to 2");
    expect(() => parseService(service("services:\n  a:\n    image: nginx\n    volumes:\n      - 'data:/x;rm'\n"), context)).toThrow("Invalid Docker volume definition");
  });

  it("marks a part that left the file, and keeps a converted part's kind", () => {
    const store = service("services:\n  web:\n    image: nginx\n  db:\n    image: postgres:16\n");
    parseService(store, context);
    expect(store.applications().map((row) => row.name)).toEqual(["web"]);
    expect(store.databases().map((row) => row.name)).toEqual(["db"]);
    store.rows().service.docker_compose_raw = "services:\n  web:\n    image: postgres:16\n";
    const web = store.applications()[0];
    if (web) web.is_migrated = true;
    parseService(store, context);
    expect(store.applications().map((row) => [row.name, row.is_removed_from_compose])).toEqual([["web", false]]);
    expect(store.databases().map((row) => [row.name, row.is_removed_from_compose])).toEqual([["db", true]]);
  });

  it("applies a template's prerequisites by the service's name", () => {
    const store = service("services:\n  beszel:\n    image: x\n");
    store.rows().service.name = "beszel-svc";
    parseService(store, context);
    applyServiceApplicationPrerequisites(store);
    expect(store.applications()[0]?.is_gzip_enabled).toBe(false);
  });
});
