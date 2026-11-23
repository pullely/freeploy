# deploy-core-worker — runbook

- **Health:** `GET /health` (service binding) reports whether the database,
  membership and policy bindings are configured.
- **A request returns 404 for an org the caller belongs to:** policy denied
  `deploy.resource.*` for their role, or membership had no fact for them.
- **Rows "missing":** every query is confined by RLS to `deploy.org_id`. A
  query run outside `withOrg()` sees nothing by design.
