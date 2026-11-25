// Writes reparse-cases.json: edits of template Compose files that emit-reparse.php saves through Coolify's
// "Edit Compose file" (StackForm::saveCompose) and that service-reparse.test.ts replays. Each case is a list
// of exact text replacements on the template's Compose file, so the edited file is the same on both sides.
//
//   node gen-reparse-cases.mjs <catalogue json> > reparse-cases.json
//
// <catalogue json>: templates/service-templates-latest.json of the Coolify checkout the goldens come from.
// Only templates whose Compose file is the same in Freeploy's shipped catalogue are used (DP-59: 351 of them).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const coolify = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shippedText = readFileSync(join(here, "../../../../apps/deploy-core-worker/src/services/catalogue-data.ts"), "utf8");
const shipped = JSON.parse(JSON.parse(shippedText.slice(shippedText.indexOf("= ") + 2, shippedText.lastIndexOf(";"))));
const compose = (name) => Buffer.from(coolify[name].compose, "base64").toString("utf8");
// The edits apply to the stored file, which is the template's unless the parser removed `content:` from it.
const usable = (name) => coolify[name] && shipped[name] && coolify[name].compose === shipped[name].compose && !/^\s+content:/m.test(compose(name));

const lines = (text) => text.split("\n");
/** The services: block — the indentation of its keys and each service's line range. */
function services(text) {
  const all = lines(text);
  const start = all.findIndex((line) => /^services:\s*$/.test(line));
  if (start === -1) return null;
  let end = all.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
  if (end === -1) end = all.length;
  const keyIndent = all.slice(start + 1, end).find((line) => /^\s+[^\s#-]/.test(line))?.match(/^(\s+)/)?.[1] ?? "  ";
  const blocks = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = all[index];
    if (line.startsWith(keyIndent) && !line.startsWith(keyIndent + " ") && /^\s+[\w.'"-]+:/.test(line)) blocks.push({ name: line.trim().replace(/:.*$/, "").replace(/['"]/g, ""), from: index });
  }
  blocks.forEach((block, index) => {
    block.to = index + 1 < blocks.length ? blocks[index + 1].from : end;
    // Blank lines after a block belong to what follows it.
    while (block.to > block.from + 1 && all[block.to - 1].trim() === "") block.to -= 1;
  });
  return { all, start, end, keyIndent, blocks };
}

const once = (text, search) => text.split(search).length === 2;
const cases = [];
const add = (id, template, replacements) => cases.push({ id, template, replacements });

const order = Object.keys(coolify).filter(usable).sort();
// Each kind of edit on templates no other kind used yet, so the cases cover as many templates as they can.
const used = new Set();
const pick = (wanted, test, count) => {
  const chosen = wanted.filter((name) => usable(name) && !used.has(name) && test(name));
  for (const name of order) if (chosen.length < count && !chosen.includes(name) && !used.has(name) && test(name)) chosen.push(name);
  for (const name of chosen.slice(0, count)) used.add(name);
  return chosen.slice(0, count);
};

// 1. A service's image changes: a new tag, a new image, an application's image turned into a database's.
const imageLine = (name) => lines(compose(name)).find((line) => /^\s+image:\s*\S/.test(line) && once(compose(name), line));
for (const name of pick(["umami", "uptime-kuma", "gitea", "ghost", "vaultwarden"], imageLine, 5)) {
  const line = imageLine(name);
  const indent = line.match(/^(\s+)/)[1];
  add(`image-${name}`, name, [{ search: `${line}\n`, replace: `${indent}image: 'nginx:1.27-alpine'\n` }]);
}
for (const name of pick(["glance", "mosquitto"], imageLine, 2)) {
  const line = imageLine(name);
  add(`image-to-database-${name}`, name, [{ search: `${line}\n`, replace: `${line.match(/^(\s+)/)[1]}image: 'postgres:16-alpine'\n` }]);
}

// 2. A service is added to the file (with a URL, a generated password and a named volume), and one is removed.
const extra = (indent) =>
  [
    `${indent}freeploy-extra:`,
    `${indent}  image: 'busybox:1.36'`,
    `${indent}  environment:`,
    `${indent}    - SERVICE_URL_FREEPLOYEXTRA_8080`,
    `${indent}    - EXTRA_PASSWORD=\${SERVICE_PASSWORD_FREEPLOYEXTRA}`,
    `${indent}    - EXTRA_NAME=\${EXTRA_NAME:-freeploy}`,
    `${indent}  volumes:`,
    `${indent}    - 'freeploy-extra-data:/data'`,
    `${indent}    - './freeploy-extra/config.txt:/etc/extra/config.txt'`,
  ].join("\n") + "\n";
for (const name of pick(["umami", "n8n", "nextcloud", "wordpress-with-mysql"], (n) => services(compose(n))?.blocks.length > 0, 4)) {
  const s = services(compose(name));
  const last = s.blocks[s.blocks.length - 1];
  const tail = s.all.slice(last.from, last.to).join("\n") + "\n";
  if (!once(compose(name), tail)) continue;
  add(`add-service-${name}`, name, [{ search: tail, replace: tail + extra(s.keyIndent) }]);
}
for (const name of pick(["plane", "supabase", "appwrite", "authentik"], (n) => services(compose(n))?.blocks.length > 1, 4)) {
  const s = services(compose(name));
  const last = s.blocks[s.blocks.length - 1];
  const block = s.all.slice(last.from, last.to).join("\n") + "\n";
  if (!once(compose(name), block)) continue;
  add(`remove-service-${name}`, name, [{ search: block, replace: "" }]);
}

// 3. A port changes: the port of a SERVICE_URL_/SERVICE_FQDN_ declaration (every occurrence of that name).
const portToken = (name) => compose(name).match(/SERVICE_(?:URL|FQDN)_[A-Z0-9]+_(\d+)\b/)?.[0];
for (const name of pick(["umami", "ghost", "gitea", "uptime-kuma", "n8n"], portToken, 5)) {
  const token = portToken(name);
  const port = Number(token.match(/_(\d+)$/)[1]);
  const changed = token.replace(/_(\d+)$/, `_${port + 1}`);
  add(`port-${name}`, name, [{ search: token, replace: changed, all: true }]);
}

// 4. A variable is added to a service's environment (a literal, a default, and a generated one).
function environmentInsert(name) {
  const all = lines(compose(name));
  const index = all.findIndex((line, i) => /^\s+environment:\s*$/.test(line) && all[i + 1] !== undefined);
  if (index === -1) return null;
  const next = all[index + 1];
  const indent = next.match(/^(\s+)/)?.[1];
  if (!indent || !once(compose(name), `${all[index]}\n${next}\n`)) return null;
  const list = next.trim().startsWith("- ");
  const entries = list ? ["- FREEPLOY_ADDED=hello", "- FREEPLOY_DEFAULT=${FREEPLOY_DEFAULT:-fallback}", "- FREEPLOY_SECRET=${SERVICE_PASSWORD_FREEPLOYADDED}"] : ["FREEPLOY_ADDED: hello", "FREEPLOY_DEFAULT: ${FREEPLOY_DEFAULT:-fallback}", "FREEPLOY_SECRET: ${SERVICE_PASSWORD_FREEPLOYADDED}"];
  return { search: `${all[index]}\n${next}\n`, replace: `${all[index]}\n${entries.map((entry) => indent + entry).join("\n")}\n${next}\n` };
}
for (const name of pick(["umami", "ghost", "vaultwarden", "gitea", "glance"], environmentInsert, 5)) add(`env-${name}`, name, [environmentInsert(name)]);

// 5. A volume is added to a service: a named volume and a bind-mounted file.
function volumeInsert(name) {
  const all = lines(compose(name));
  const index = all.findIndex((line, i) => /^\s{3,}volumes:\s*$/.test(line) && /^\s+- /.test(all[i + 1] ?? ""));
  if (index === -1) return null;
  const next = all[index + 1];
  const indent = next.match(/^(\s+)/)[1];
  if (!once(compose(name), `${all[index]}\n${next}\n`)) return null;
  return { search: `${all[index]}\n${next}\n`, replace: `${all[index]}\n${indent}- 'freeploy-added:/freeploy/data'\n${indent}- './freeploy/notes.txt:/freeploy/notes.txt'\n${next}\n` };
}
for (const name of pick(["uptime-kuma", "gitea", "vaultwarden", "nextcloud", "mosquitto"], volumeInsert, 5)) add(`volume-${name}`, name, [volumeInsert(name)]);

// 6. Several edits at once: a port, a variable and a volume.
for (const name of pick(["immich", "formbricks"], (n) => portToken(n) && environmentInsert(n) && volumeInsert(n), 2)) {
  const token = portToken(name);
  const env = environmentInsert(name);
  const volume = volumeInsert(name);
  if (env.search === volume.search) continue;
  add(`combined-${name}`, name, [env, volume, { search: token, replace: token.replace(/_(\d+)$/, (_, port) => `_${Number(port) + 10}`), all: true }]);
}

process.stdout.write(JSON.stringify({ cases }, null, 2) + "\n");
