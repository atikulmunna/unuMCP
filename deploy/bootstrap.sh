#!/bin/bash
# First-boot bootstrap for the unuMCP demo box (Amazon Linux 2023, arm64).
# Runs as root via EC2 user-data. Secret-free by design: it reads GEMINI_API_KEY,
# JWT_SECRET and DB_PASSWORD from the environment that provision.sh prepends to
# this file at launch (so no secret is ever committed to the repo).
set -euxo pipefail
exec > /var/log/unumcp-bootstrap.log 2>&1
echo "unuMCP bootstrap started: $(date -u)"

REPO="${UNUMCP_REPO:-https://github.com/atikulmunna/unuMCP.git}"
APP=/opt/unumcp
DB_URL="postgresql://unumcp:${DB_PASSWORD}@localhost:5432/unumcp?schema=public"

# 1. Swap — protects `pnpm install` / `next build` on a 2 GB box.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Docker + git.
dnf install -y docker git
systemctl enable --now docker

# 3. Node 22 (pnpm 11 needs >= 22.13) + pnpm, on deterministic paths for systemd.
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
npm install -g pnpm@11.5.1
ln -sf "$(command -v node)" /usr/local/bin/node
ln -sf "$(command -v pnpm)" /usr/local/bin/pnpm

# 4. cloudflared (arm64 raw binary) for the free quick tunnel.
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 5. Postgres 16 (loopback-only), data on a host volume.
docker run -d --name unumcp-pg --restart always \
  -e POSTGRES_USER=unumcp -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=unumcp \
  -p 127.0.0.1:5432:5432 -v /opt/pgdata:/var/lib/postgresql/data postgres:16

# 6. Clone + configure (the .env is written here, never committed).
git clone --depth 1 "$REPO" "$APP"
cat > "$APP/apps/api/.env" <<EOF
DATABASE_URL="$DB_URL"
JWT_SECRET=$JWT_SECRET
GEMINI_API_KEY=$GEMINI_API_KEY
PORT=3001
EOF

# 7. Install, migrate, build the web.
cd "$APP"
export NEXT_TELEMETRY_DISABLED=1 CI=true
pnpm install --frozen-lockfile
until docker exec unumcp-pg pg_isready -U unumcp; do sleep 2; done
( cd packages/db && DATABASE_URL="$DB_URL" pnpm exec prisma db push --skip-generate )
( cd apps/web && pnpm build )

# 8. systemd units: API, Web, and the tunnel — all auto-start on every boot.
cat > /etc/systemd/system/unumcp-api.service <<EOF
[Unit]
Description=unuMCP API
After=docker.service
Requires=docker.service
[Service]
WorkingDirectory=$APP/apps/api
ExecStart=/usr/local/bin/node --env-file=.env -r @swc-node/register src/main.ts
Environment=NODE_ENV=production
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/unumcp-web.service <<EOF
[Unit]
Description=unuMCP Web
After=unumcp-api.service
[Service]
WorkingDirectory=$APP/apps/web
ExecStart=/usr/local/bin/pnpm start
Environment=NODE_ENV=production
Environment=API_URL=http://localhost:3001
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/unumcp-tunnel.service <<EOF
[Unit]
Description=unuMCP Cloudflare quick tunnel
After=unumcp-web.service
[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://localhost:3000
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now unumcp-api unumcp-web unumcp-tunnel
echo "unuMCP bootstrap finished: $(date -u)"
