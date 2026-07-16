# Deploying unuMCP (AWS, on-demand demo box)

A fully scripted deploy of the whole platform onto one small EC2 box. Chosen for
one reason: unuMCP runs generated code in a **Docker sandbox**, which needs a real
Docker daemon (Render/Railway free tiers can't do this). Everything else (Postgres,
inline job queue, Gemini free-tier LLM, Cloudflare quick tunnel) rides along.

## What it creates

| Resource | Detail |
| --- | --- |
| EC2 instance | `t4g.small` (ARM, 2 vCPU, 2 GB) + 4 GB swap, 20 GB gp3, Amazon Linux 2023 |
| Security group | `unumcp-sg` — **no inbound rules** (access is via SSM + the tunnel, both outbound) |
| IAM role | `unumcp-ssm-role` — `AmazonSSMManagedInstanceCore` (Session Manager; no SSH keys) |
| Runtime | Postgres 16 container + API + Web + `cloudflared` quick tunnel, all as systemd services |

Access is a free `https://<random>.trycloudflare.com` URL (no Cloudflare account needed).

## Prerequisites

- AWS CLI authenticated (`aws sts get-caller-identity` works).
- `GEMINI_API_KEY` present in `apps/api/.env` (the provisioner reads it and injects it
  at launch only; it is never committed). `JWT_SECRET` and the DB password are generated.

## 1. Provision (one command)

```bash
bash deploy/provision.sh
```

Launches the box and hands it a self-contained bootstrap (installs Docker/Node/pnpm/
cloudflared, clones the repo, writes `.env`, `pnpm install`, `prisma db push`, builds the
web, starts all services). **First boot takes ~8-10 min.**

```bash
bash deploy/manage.sh bootlog   # watch bootstrap progress
bash deploy/manage.sh url       # print the demo URL once the tunnel is up
```

## 2. Day-to-day (on-demand)

```bash
bash deploy/manage.sh stop      # after a demo — billing drops to ~disk only (~$0.02/day)
bash deploy/manage.sh start     # ~30s later, prints the fresh URL
bash deploy/manage.sh status    # state + public IP
bash deploy/manage.sh ssh       # SSM shell on the box (no keys, no open ports)
bash deploy/manage.sh logs      # tail API/web/tunnel logs
```

The quick-tunnel URL **changes on each start** (it's the free, no-account tunnel). `start`
prints the current one. Want a stable URL? See "Stable URL" below.

## 3. Redeploy after pushing code

```bash
bash deploy/manage.sh ssh
# on the box:
cd /opt/unumcp && git pull && pnpm install && (cd apps/web && pnpm build) \
  && sudo systemctl restart unumcp-api unumcp-web
```

## 4. Tear down (stops all billing)

```bash
bash deploy/manage.sh teardown  # terminates the instance, deletes the SG + IAM role
```

## Cost (on-demand)

- Running: **~$0.017/hr** — an hour-long demo is under 2 cents.
- Stopped (ready to start in ~30s): **~$1.60/mo** — the 20 GB gp3 volume only.
- For **near-zero** cost between demo seasons: `teardown` (deletes the volume) and re-run
  `provision.sh` when you need it again (one command, ~10 min). Nothing bills while torn down.

The 20 GB disk (up from a too-small 8 GB) holds the OS, the pnpm monorepo `node_modules`, the
Next build, the Postgres image/data, and the `node:22-slim` sandbox image plus its per-run
`npm install` scratch. 8 GB fills up and the sandbox fails with "no space left on device".

## Notes & caveats

- **Secrets:** injected via EC2 user-data at launch (visible only through the instance's
  own metadata, which is IMDSv2-only and behind a no-inbound SG). Fine for a single-user
  demo. For hardening, move them to SSM Parameter Store (SecureString) and have the box
  pull them with its role.
- **2 GB RAM:** the 4 GB swapfile covers the one-time `next build` and the sandbox's
  `npm install` spikes. The sandbox container itself is capped at 512 MB.
- **Cancel-zombie (P4-10):** cancelling a running test SIGKILLs the docker client, not the
  `--rm` container, so a container can linger briefly. Harmless for a demo; it's the
  deferred infra item.
- **Single instance:** the in-memory rate limiter and SSE log bus assume one box (fine
  here). Multi-instance would need the Redis-backed variants.

## Stable URL (optional, needs a free Cloudflare account)

Replace the quick tunnel with a **named tunnel**: create one in the Cloudflare Zero Trust
dashboard (Networks → Tunnels), map a hostname to `http://localhost:3000`, copy the token,
and change the `unumcp-tunnel` service to `cloudflared tunnel run --token <TOKEN>`. The URL
then stays constant across start/stop.
