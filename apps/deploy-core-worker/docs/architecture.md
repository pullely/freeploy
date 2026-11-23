# deploy-core-worker — architecture

```
api-edge ──service binding──▶ deploy-core-worker ──Hyperdrive──▶ Postgres (schema deploy, RLS)
                                   │
                                   ├──▶ membership-worker (authorization context)
                                   └──▶ policy-worker (decision)
```

Later milestones add the `SshSession` Durable Object and the ssh-executor
container (DP4), Workflows for deployments and backups (DP5, DP7), Queues and
Cron Triggers for Coolify's scheduler (DP9), and the `OrgRealtime` Durable
Object (DP3–DP5).
