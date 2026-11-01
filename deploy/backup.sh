#!/bin/bash
# Dump the app database and upload it to S3. Run nightly by
# unumcp-backup.service (see install-backups.sh), or now with
# `bash deploy/manage.sh backup`.
set -euo pipefail
: "${BACKUP_BUCKET:?BACKUP_BUCKET is not set (see /etc/unumcp-backup.env)}"

dump="$(mktemp /var/tmp/unumcp-XXXXXX.dump)"
trap 'rm -f "$dump"' EXIT
# Dump to a file first, so a failed dump never uploads a truncated backup.
docker exec unumcp-pg pg_dump -U unumcp -d unumcp --format=custom > "$dump"
[ -s "$dump" ] || { echo "pg_dump wrote nothing" >&2; exit 1; }

key="postgres/unumcp-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
aws s3 cp "$dump" "s3://$BACKUP_BUCKET/$key" --only-show-errors
echo "Backed up $(du -h "$dump" | cut -f1) to s3://$BACKUP_BUCKET/$key"
