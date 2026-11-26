// Editing a service's Compose file (DP-66) against Coolify's own PHP. fixtures/services/reparse-goldens.json.gz
// is what coollabsio/coolify@91b7e3e does when the "Edit Compose file" dialog saves an edited file: each case
// of reparse-cases.json creates a service from its template (`before`), applies the case's edits — an image
// changed, a service added or removed, a port changed, a variable or a volume added — and saves the text through
// StackForm (`after`, with the toasts it dispatched): the fields its page loaded, the rules, the fields written
// back, and the Compose file parsed again on the rows already stored (emit-reparse.php, see the README there).
//
// The port must load the same fields, refuse what PHP refused with the same message, and otherwise arrive at
// the same rows and the same bytes: parts reconciled by name (a removed service marked, not deleted), the
// variables and volumes of the stored rows kept and the new ones added. Random values are replayed as in
// service-parser.test.ts; services.config_hash is left out (Freeploy does not compute it, see the status note).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createServiceFromTemplate, newServiceFromTemplate } from "@deploy-core-worker/services/parser";
import { MemoryServiceStore } from "@deploy-core-worker/services/store";
import { stackFormFields } from "@deploy-core-worker/services/extra-fields";
import { StackFormError, submitStackForm } from "@deploy-core-worker/services/stack-form";
import { asGolden, contextFor, difference, type GoldenState, type Goldens } from "./service-golden-rows";

interface Case {
  id: string;
  template: string;
  replacements: { search: string; replace: string; all?: boolean }[];
}
type GoldenField = { key: string; name: string; serviceName: string; isPassword: boolean; isLocked: boolean; rules: string; value: string | null };
interface ReparseGoldens {
  fixture: Goldens["fixture"] & { server: Goldens["fixture"]["server"] & { is_functional: boolean } };
  cases: Record<string, { ok: true; template: string; raw: string; fields: GoldenField[]; isPasswordHiddenForMember: boolean; events: [string, string | null][]; before: GoldenState; after: GoldenState } | { ok: false; template: string; error: string }>;
}

const fixtures = join(process.cwd(), "fixtures", "services");
const goldens = JSON.parse(gunzipSync(readFileSync(join(fixtures, "reparse-goldens.json.gz"))).toString("utf8")) as ReparseGoldens;
const cases = (JSON.parse(readFileSync(join(fixtures, "reparse-cases.json"), "utf8")) as { cases: Case[] }).cases;

/** The case's replacements, as emit-reparse.php applies them. */
function edited(raw: string, replacements: Case["replacements"]): string {
  let text = raw;
  for (const { search, replace, all } of replacements) {
    const count = text.split(search).length - 1;
    if (count === 0 || (count > 1 && !all)) throw new Error(`the replacement's text occurs ${count} times`);
    text = text.split(search).join(replace);
  }
  return text;
}

/** config_hash is Coolify's md5 of the rows with their timestamps: not compared. */
const withoutConfigHash = (state: GoldenState): GoldenState => ({ ...state, service: { ...state.service, config_hash: null } });

describe("editing a service's Compose file, against Coolify's StackForm for 32 templates", () => {
  it("has a golden for every case, on Coolify's default server, which is not functional", () => {
    expect(cases).toHaveLength(32);
    expect(new Set(cases.map((c) => c.template)).size).toBe(32);
    expect(Object.keys(goldens.cases)).toEqual(cases.map((c) => c.id));
    expect(Object.values(goldens.cases).filter((c) => !c.ok)).toEqual([]);
    expect(goldens.fixture.server).toMatchObject({ wildcard_domain: null, proxy_type: null, is_functional: false });
  });

  const outcomes = { saved: 0, refused: 0 };
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
    const golden = goldens.cases[testCase.id];
    if (!golden?.ok) throw new Error("no golden");
    const shapeErrors: string[] = [];
    const created = newServiceFromTemplate({ type: `one-click-service-${testCase.template}`, uuid: goldens.fixture.service_uuid });
    if (!created) throw new Error("not in the shipped catalogue");
    const store = MemoryServiceStore.forService(created.service);
    const creating = contextFor(goldens.fixture, golden.before, shapeErrors);
    createServiceFromTemplate(store, created.environment, creating);
    expect(difference(asGolden(store.rows()), withoutConfigHash(golden.before))).toBeNull();

    // The page: the fields mount() loads, the edited text, "Save changes".
    const raw = edited(store.service.docker_compose_raw ?? "", testCase.replacements);
    expect(raw).toBe(golden.raw);
    const fields = stackFormFields(store, golden.isPasswordHiddenForMember).map(({ key, name, serviceName, isPassword, isLocked, rules, value }) => ({ key, name, serviceName, isPassword, isLocked, rules, value }));
    expect(fields).toEqual(golden.fields);
    const name = store.service.name;
    const refused = golden.events.find(([event]) => event === "error");
    const save = () =>
      submitStackForm(
        store,
        { name, dockerComposeRaw: raw, connectToDockerNetwork: store.service.connect_to_docker_network, fields: Object.fromEntries(golden.fields.map((field) => [field.key, field.value])) },
        // The parts' uuids go on counting, as the emitter's model event does.
        { parser: { ...contextFor(goldens.fixture, golden.after, shapeErrors), newUuid: creating.newUuid ?? (() => "") }, canManageEnvironment: !golden.isPasswordHiddenForMember, description: null },
      );
    if (refused) {
      expect(save).toThrow(StackFormError);
      try {
        save();
      } catch (error) {
        expect((error as Error).message).toBe(refused[1]);
      }
      outcomes.refused += 1;
    } else {
      expect(golden.events).toEqual([["success", save().message]]);
      outcomes.saved += 1;
    }
    expect(shapeErrors).toEqual([]);
    expect(difference(asGolden(store.rows()), withoutConfigHash(golden.after))).toBeNull();
  });

  it("saved 25 of the edited files and refused 7, as Coolify did", () => {
    expect(outcomes).toEqual({ saved: 25, refused: 7 });
  });
});
