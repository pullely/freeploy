// Writes cases.json (`node cases.mjs > cases.json`): the documents emit.php gives to symfony/yaml's Yaml::parse() and to
// Coolify's ValidCloudInitYaml, so that apps/deploy-core-worker/src/yaml/symfony can be held to them (see README.md).
// `cases`: hand-written documents, by what they exercise; `fuzz`: documents put together from YAML fragments by a seeded
// generator (the same 3000 every time), so that the rules' interplay is covered beyond the cases one thinks of.

const cases = [];
const add = (id, yaml) => cases.push({ id, yaml });

// ── valid documents ─────────────────────────────────────────────────────────
add("empty", "");
add("blank lines", "\n\n  \n");
add("comment only", "# just a comment\n");
add("scalar", "hello");
add("scalar number", "42");
add("scalar quoted", '"a \\t b \\u00e9 \\x41 \\U0001F600"');
add("scalar single quoted", "'it''s'");
add("cloud-config", "#cloud-config\npackage_update: true\npackages:\n  - curl\n  - git\nruncmd:\n  - [sh, -c, 'echo hi']\n  - echo \"done\"\n");
add("cloud-config users", "users:\n  - name: deploy\n    groups: sudo\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n      - ssh-ed25519 AAAAC3Nza deploy@host\n");
add("write_files", "write_files:\n  - path: /etc/motd\n    content: |\n      Welcome\n      to the server\n    permissions: '0644'\n");
add("folded", "a: >\n  one\n  two\n\n  three\nb: 1\n");
add("folded keep", "a: >+\n  one\n\nb: 1\n");
add("literal strip", "a: |-\n  one\n  two\n");
add("literal indent", "a: |2\n    one\n   two\n");
add("literal at end", "a: |\n  x");
add("literal empty", "a: |\nb: 1\n");
add("literal keep empty", "a: |+\n\n\nb: 1\n");
add("nested", "a:\n  b:\n    c: 1\n    d: [x, y]\n  e: {f: g, h: [1, {i: j}]}\n");
add("sequence of mappings", "- a: 1\n  b: 2\n- c: 3\n");
add("sequence nested", "- - 1\n  - 2\n- - 3\n");
add("unindented sequence", "a:\n- 1\n- 2\nb: 3\n");
add("anchors", "base: &base\n  x: 1\n  y: 2\nderived:\n  <<: *base\n  y: 3\n");
add("merge list", "a: &a {x: 1}\nb: &b {y: 2}\nc:\n  <<: [*a, *b]\n  z: 3\n");
add("merge inline", "a: &a {x: 1}\nc: {<<: *a, z: 3}\n");
add("alias scalar", "a: &v hello\nb: *v\n");
add("alias in sequence", "- &x 1\n- *x\n");
add("types", "i: 12\nneg: -3\noct: 0o17\nhex: 0x1F\nf: 1.5\nexp: 1e3\ninf: .inf\nninf: -.inf\nnan: .NaN\nt: true\nf2: FALSE\nn: ~\nn2: null\nver: 1.10.0\nzero: 0755\nunder: 1_000\nplus: +12\nbig: 99999999999999999999\ndate: 2024-01-02\nts: 2024-01-02T03:04:05Z\nfrac: 2024-01-02 03:04:05.5\n");
add("strings", "a: yes\nb: no\nc: on\nd: 'quoted: colon'\ne: \"line\\nbreak\"\nf: foo # comment\ng: foo#bar\nh: http://example.com:8080/x\n");
add("quoted keys", "'a b': 1\n\"c: d\": 2\n'1': 3\n");
add("int keys", "1: a\n2: b\n'3': c\n");
add("empty values", "a:\nb: ~\nc: ''\n");
add("multi-line plain", "a: one\n  two\n  three\nb: x\n");
add("multi-line plain blank", "a: one\n\n  two\n");
add("multi-line quoted", "a: \"one\n  two\"\nb: 'x\n\n  y'\n");
add("document start", "---\na: 1\n");
add("document start comment", "--- # doc\na: 1\n");
add("document end", "a: 1\n...\n");
add("yaml directive", "%YAML 1.2\n---\na: 1\n");
add("bom", "\uFEFFa: 1\n");
add("crlf", "a: 1\r\nb:\r\n  - 2\r\n");
add("trailing spaces", "a: 1   \nb: 2\t\n");
add("comments between", "a:\n  # c1\n  b: 1\n# c2\n  c: 2\n");
add("flow multi-line", "a: [1,\n  2,\n  3]\nb: {x: 1,\n  y: 2}\n");
add("flow nested empty", "a: []\nb: {}\nc: [[], {}]\n");
add("flow trailing comma", "a: [1, 2, ]\nb: {x: 1, }\n");
add("flow embedded mapping", "a: [x: 1, y: 2]\n");
add("str tag", "a: !!str 123\nb: !!str\n");
add("float tag", "a: !!float 3\n");
add("binary tag", "a: !!binary aGVsbG8=\n");
add("non-specific tag", "a: ! 12\n");
add("unicode", "name: Zoë\ncity: 東京\nemoji: \"😀\"\n");
add("long line key", `key: ${"x".repeat(300)}\n`);
add("colon no space", "a:b\n");
add("url value", "- http://a.b/c?d=e\n");
add("hash in quotes", "a: \"# not a comment\"\n");
add("dash scalar", "a: -\nb: - x\n");
add("sequence with comments", "- 1 # one\n# between\n- 2\n");
add("question key", "a: ?x\n");
add("tilde key", "~: 1\n");
add("null key", "null: 1\n");
add("bool key", "true: 1\n");
add("float key", "1.5: x\n");

// ── errors ──────────────────────────────────────────────────────────────────
add("duplicate key", "a: 1\na: 2\n");
add("duplicate key nested", "x:\n  a: 1\n  a: 2\n");
add("duplicate key null", "a:\na:\n");
add("duplicate key after block", "a:\n  b: 1\na:\n  c: 2\n");
add("duplicate key inline", "a: {b: 1, b: 2}\n");
add("duplicate key inline null", "a: {b: ~, b: 2}\n");
add("unclosed flow sequence", "a: [1, 2\n");
add("unclosed flow mapping", "a: {b: 1\n");
add("unclosed flow root", "[1, 2\n");
add("unclosed flow mapping root", "{a: 1\n");
add("unclosed quote", "a: \"abc\n");
add("unclosed single quote", "a: 'abc\n");
add("tab indentation", "\tpackages: []\n");
add("tab nested", "a:\n\tb: 1\n");
add("tab after content", "a:\n  b: 1\n\tc: 2\n");
add("tab in sequence", "-\ta\n");
add("colon in value", "a: b: c\n");
add("colon in value multi-line", "a: b\n  c: d\n");
add("colon in sequence value", "- a: b: c\n");
add("mapping in sequence", "- a\nb: 1\n");
add("sequence in mapping", "a: 1\n- b\n");
add("missing reference", "a: *nope\n");
add("missing reference inline", "a: [*nope]\n");
add("missing merge reference", "a:\n  <<: *nope\n");
add("merge scalar", "a: &a 1\nb:\n  <<: *a\n");
add("merge items scalar", "a:\n  <<: [1, 2]\n");
add("merge items scalar block", "b:\n  <<:\n    - 1\n");
add("circular reference", "a: &a\n  b: *a\n");
add("indentation problem", "a:\n    b: 1\n  c: 2\n");
add("indentation root", "  a: 1\nb: 2\n");
add("indentation problem sequence", "a:\n  - 1\n - 2\n");
add("unable to parse", "a\nb: 1\n");
add("unable to parse quoted", "a: 1\n\"b\"\n");
add("unable to parse flow after", "[1]\nfoo\n");
add("unexpected chars after quote", "a: \"x\" y\n");
add("unexpected chars inline", "[1] x\n");
add("unexpected token", "a: [1] x\n");
add("reserved indicator @", "a: @foo\n");
add("reserved indicator backtick", "a: `foo`\n");
add("reserved indicator percent", "a: %foo\n");
add("reserved indicator pipe inline", "a: [|x]\n");
add("multiple documents", "a: 1\n---\nb: 2\n");
add("multiple documents end", "a: 1\n...\nb: 2\n");
add("complex mapping", "? a\n: b\n");
add("complex mapping sequence", "- ? a\n");
add("custom tag", "a: !foo bar\n");
add("custom tag block", "a: !foo\n  b: 1\n");
add("builtin tag not implemented", "a: !!map {}\n");
add("builtin tag inline", "a: [!!int 1]\n");
add("unsupported builtin", "a: !!int 1\n");
add("lone bang", "a: [!]\n");
add("invalid escape", "a: \"\\q\"\n");
add("invalid escape unicode", "a: \"\\é\"\n");
add("invalid date", "a: 2024-13-45\n");
add("binary invalid length", "a: !!binary abc\n");
add("binary invalid chars", "a: !!binary ab$=\n");
add("numeric key", "a: {1.5: x}\n");
add("non-string key", "? x\n");
add("implicit cast key", "{true: 1}\n");
add("colon without space inline", "a: {b:c}\n");
add("missing mapping key", "a: {: x}\n");
add("mapping values in multi-line", "a\nb: c\n");
add("empty reference", "a: [*]\n");
add("unexpected end of line", "a: ['x'\n");
add("unexpected characters quoted in flow", "a: ['x' y]\n");
add("block collection on marker", "--- a: 1\n");
add("block sequence on marker", "--- - 1\n");
add("unindented key", "a:\n  b: 1\nc\n");
add("deep nesting", `${"[".repeat(130)}${"]".repeat(130)}\n`);
add("colon in key", "a:b: c\n");
add("quoted then colon", "'a': b: c\n");
add("hash key", "a #b: 1\n");
add("sequence dash only", "-\n-\n");
add("mapping after scalar", "foo\n  bar: 1\n");
add("shebang-looking", "#!/bin/bash\necho hi\n");
add("bash without shebang", "apt-get update\napt-get install -y curl\n");
add("bash with colon", "echo foo: bar\nls\n");
add("bash one line", "echo hello world");
add("bash with brace", "if [ -f /x ]; then echo; fi\n");
add("cloud-config bad", "#cloud-config\npackages:\n  - curl\n runcmd:\n  - ls\n");
add("cloud-config header only", "#cloud-config\n");
add("cloud-config tab", "#cloud-config\n\tpackages: []\n");
add("cloud-config unclosed", "#cloud-config\nruncmd: [ls,\n");
add("cloud-config header space", "#cloud-config   \n\n  # c\npackages: [a]\n");
add("invalid utf8-ish latin", "a: caf\u00e9 \u00a0x\n");
add("nbsp", "a:\u00a0b\n");
add("numbers 0 snippet", "0\n0: 1\n0: 2\n");
add("zero snippet", "a: 1\n0\n");

// ── fuzz ────────────────────────────────────────────────────────────────────
// A small linear congruential generator, so the documents are the same on every run.
let seed = 20261126;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const pick = (list) => list[rnd(list.length)];
const KEYS = ["a", "b", "key", "x y", "'q'", '"d"', "1", "<<", "a#b", "k:", "-k", "&r k", "!t k", "?", "url", "true", "~", "1.5", "é"];
const VALUES = [
  "", "1", "-1", "0x1F", "1.0", "yes", "~", "null", "foo", "foo bar", "foo: bar", "foo:bar", "\"q\"", "'s''s'", "\"a\\nb\"", "\"bad\\q\"", "'open", "\"open",
  "[1, 2]", "[1, [2, 3]]", "[a: 1]", "{a: 1}", "{a: 1, a: 2}", "{a:1}", "[1, 2", "{a: 1", "[]", "{}", "*r", "*missing", "&r 5", "&r", "!foo x", "!!str 1", "!!binary aGk=",
  "|", "|-", ">", ">+", "|2", "@x", "`x`", "%x", "x # c", "x #c", "#c", "- 1", "-", "2024-01-01", "2024-02-30", "http://x:1/y", "a, b", "a]", "a}", "\t", "é ü",
];
const CONTINUATIONS = ["2]", "b: 1}", "x\"", "y'", "  more text", "]", "}", "- nested", "c: d", "# c", "\\", "e: [f,", "g]"];
const INDENTS = ["", "", " ", "  ", "  ", "   ", "    ", "    ", "      ", "", "  ", "\t", "  \t"];
function fuzzLine(depth) {
  const indent = depth === 0 ? pick(["", "", "", "", "", "", "", " ", "\t"]) : pick(INDENTS);
  switch (rnd(13)) {
    case 10:
      return `${indent}${pick(CONTINUATIONS)}`;
    case 11:
      return `${indent}${pick(KEYS)}: ${pick(["|", "|-", ">", "|+", ">2", "[1,", "{a: 1,", "\"open", "'open", "&r", "!!str", "*r"])}`;
    case 12:
      return `${indent}- ${pick(["|", "[a,", "&r", "- x", "k: v", "\"q"])}`;
    case 0:
      return `${indent}- ${pick(VALUES)}`;
    case 1:
      return `${indent}-`;
    case 2:
      return `${indent}# ${pick(VALUES)}`;
    case 3:
      return "";
    case 4:
      return `${indent}${pick(VALUES)}`;
    case 5:
      return `${indent}- ${pick(KEYS)}: ${pick(VALUES)}`;
    default:
      return `${indent}${pick(KEYS)}:${pick([" ", " ", "  ", "\t", ""])}${pick(VALUES)}`;
  }
}
const fuzz = [];
for (let n = 0; n < 3000; n++) {
  const lines = [];
  const count = 1 + rnd(8);
  for (let l = 0; l < count; l++) lines.push(fuzzLine(l));
  let yaml = lines.join("\n");
  if (rnd(3) > 0) yaml += "\n";
  if (rnd(8) === 0) yaml = `---\n${yaml}`;
  if (rnd(10) === 0) yaml = `#cloud-config\n${yaml}`;
  fuzz.push({ id: `fuzz-${n}`, yaml });
}

console.log(JSON.stringify({ cases, fuzz }, null, 1));
