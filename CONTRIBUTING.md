# Contributing to Freeploy

Thanks for helping. Freeploy is a multi-tenant port of Coolify (Apache-2.0)
whose goal is **exact parity**: the same features, defaults, validations,
copy and screens as Coolify at the pinned commit, on a different
architecture. That shapes how changes land.

## The rules

- **The Coolify source is the spec.** For a feature, read the Coolify model,
  Livewire component, Blade view, Action, Job and helper at the pinned commit
  (`specs/epics/freeploy-coolify-parity/parity/` lists every unit) and port
  it; do not redesign it.
- **Commands are byte-for-byte.** Shell commands run on servers must match
  Coolify's output for the same inputs; golden tests enforce it.
- **Tenancy first.** Every row, query, queue message, workflow, Durable
  Object and SSH session is scoped to one org. Add an isolation test with
  every new table or route.
- **Attribution.** A file derived from Coolify starts with
  `// Derived from coollabsio/coolify@<ref>:<path> (Apache-2.0), modified.`
- **No Coolify brand marks.** Use "Freeploy" in user-visible copy.
- **No secrets** in code, fixtures, screenshots or logs. Fixtures are fake.

## How a change lands

Every change is one task and one pull request:

1. The task exists in the Orunbase workspace (key `DP-<k>`), with its contract
   in `tasks/DP-<k>.TaskContract.yaml`; the diff stays inside its `affects`.
2. Branch `orun/DP-<k>-<slug>`; every commit carries the trailer
   `Orun-Task: DP-<k>`.
3. The PR body ends with the `<!-- orun:manifest … -->` block.
4. It merges (squash) only when every check is green, including
   `orun/compliance` and the parity jobs. Gates are never weakened.

Local checks before pushing:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Licence

By contributing you agree your contribution is licensed under the Apache
License 2.0 (see `LICENSE`).
