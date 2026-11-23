import { test } from "node:test";
import assert from "node:assert/strict";
import { expandLoops } from "../expand.ts";

test("unrolls a literal-array loop", () => {
  const src = "foreach (['a', 'b'] as $tableName) { Schema::table($tableName, function (Blueprint $table) { $table->text('x')->nullable(); }); }";
  const out = expandLoops(src);
  assert.match(out, /Schema::table\('a'/);
  assert.match(out, /Schema::table\('b'/);
  assert.doesNotMatch(out, /\$tableName/);
});

test("unrolls $this->tables, self::CONST and a map with destructured columns", () => {
  const src = [
    "class X { private array $tables = ['p', 'q']; private const COLS = ['n1' => ['col_a', true], 'n2' => ['col_b', false]];",
    "public function up(): void {",
    "foreach ($this->tables as $t) { Schema::table($t, function (Blueprint $table) { $table->boolean('z')->default(false); }); }",
    "foreach (self::COLS as $tableName => [$column, $default]) { Schema::table($tableName, function (Blueprint $table) use ($column, $default) { $table->boolean($column)->default($default); }); }",
    "} }",
  ].join("\n");
  const out = expandLoops(src);
  for (const t of ["p", "q", "n1", "n2"]) assert.match(out, new RegExp(`Schema::table\\('${t}'`));
  assert.match(out, /\$table->boolean\('col_a'\)->default\(true\)/);
  assert.match(out, /\$table->boolean\('col_b'\)->default\(false\)/);
});
