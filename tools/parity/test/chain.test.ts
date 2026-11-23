import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStatements, parseChain, phpString } from "../chain.ts";

test("parses a column with chained modifiers and keeps their args", () => {
  const s = parseChain("$table->boolean('is_static')->default(false)->nullable();")!;
  assert.equal(s.method, "boolean");
  assert.deepEqual(s.args, ["'is_static'"]);
  assert.deepEqual(s.chain, [{ method: "default", args: ["false"] }, { method: "nullable", args: [] }]);
});

test("nested parens, commas and semicolons inside strings do not split", () => {
  const body = "$table->string('a; b', 100)->default('x,y');\n $table->timestamp('t')->default(DB::raw('now()'));\n $table->enum('s', ['a', 'b'])->default('a');";
  const stmts = splitStatements(body);
  assert.equal(stmts.length, 3);
  const a = parseChain(stmts[0])!;
  assert.deepEqual(a.args, ["'a; b'", "100"]);
  assert.deepEqual(a.chain[0].args, ["'x,y'"]);
  assert.deepEqual(parseChain(stmts[1])!.chain[0].args, ["DB::raw('now()')"]);
  assert.deepEqual(parseChain(stmts[2])!.args, ["'s'", "['a', 'b']"]);
  assert.equal(phpString("'it\\'s'"), "it's");
});
