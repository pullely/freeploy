# freeploy-coolify-parity (DP) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| DP0 — the spec | ✅ Done 2026-11-23 | DP-1 [#4](https://github.com/pullely/freeploy/pull/4) (merge `48fa9ca`) · DP-2 (this PR) |
| DP1 — parity harness | | |
| DP2 — data model | | |
| DP3 — UI shell | | |
| DP4 — servers over SSH | | |
| DP5 — applications | | |
| DP6 — sources and previews | | |
| DP7 — databases | | |
| DP8 — services | | |
| DP9 — platform features | | |
| DP10 — teams and governance | | |
| DP11 — advanced | | |
| DP12 — platform admin | | |
| DP13 — prod, docs, certification | | |

## Notes on DP0

- The epic (EP-6, `epc_78NC4FJK`), its 14 milestones and tasks DP-1/DP-2 were minted with `orun task epic|milestone|task create` because the Orunbase MCP connector in the build session was read-only; the result is the same records `epic_create`/`milestone_create`/`task_create` make.
- No `orun/compliance` check reported on #4 (only `plan`); the lineage (branch, trailer, manifest) was written regardless and `task_get DP-1` folded to `done` from the merge.
- The Lumen bootstrap is parked at `03-infrastructure`: the Supabase org behind `nexara-orun` is on the free plan at its 2-project limit (WAITING.md W4). Stage and prod are not live yet.

## Departures from the design

None yet.
