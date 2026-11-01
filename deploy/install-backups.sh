#!/bin/bash
# Turn on the nightly database backup on the demo box. Run as root, from
# bootstrap.sh on a new box or `bash deploy/manage.sh enable-backups`:
#   bash deploy/install-backups.sh <bucket> <region>
set -euo pipefail
bucket="${1:?usage: install-backups.sh <bucket> <region>}"
region="${2:?usage: install-backups.sh <bucket> <region>}"
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cat > /etc/unumcp-backup.env <<EOF
BACKUP_BUCKET=$bucket
AWS_REGION=$region
EOF

cat > /etc/systemd/system/unumcp-backup.service <<EOF
[Unit]
Description=unuMCP database backup to S3
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
EnvironmentFile=/etc/unumcp-backup.env
ExecStart=/bin/bash $app/deploy/backup.sh
EOF

cat > /etc/systemd/system/unumcp-backup.timer <<EOF
[Unit]
Description=Nightly unuMCP database backup
[Timer]
OnCalendar=daily
RandomizedDelaySec=30min
# The box is usually stopped: run a missed backup at the next start.
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now unumcp-backup.timer
echo "Nightly backups to s3://$bucket/postgres/ are on."
