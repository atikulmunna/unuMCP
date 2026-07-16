#!/bin/bash
# Lifecycle helper for the unuMCP demo box (finds the instance by its Name tag).
#
#   bash deploy/manage.sh <command>
#     url       print the current Cloudflare demo URL
#     start     start the (stopped) instance, then print the URL
#     stop      stop the instance (billing drops to ~disk only)
#     status    instance state + public IP
#     bootlog   tail the first-boot bootstrap log (via SSM)
#     logs      tail the API/web/tunnel service logs (via SSM)
#     ssh       open an SSM shell on the box (no keys/ports)
#     teardown  terminate the instance and delete the SG + IAM role
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
NAME=unumcp; ROLE=unumcp-ssm-role; SG=unumcp-sg
aws() { command aws --region "$REGION" "$@"; }

iid() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text
}

# Run a shell command on the box via SSM and print its output.
run_ssm() {
  local id cmd out
  id="$(iid)"; cmd="$1"
  out="$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --parameters "commands=[\"$cmd\"]" --query 'Command.CommandId' --output text)"
  aws ssm wait command-executed --command-id "$out" --instance-id "$id" 2>/dev/null || true
  aws ssm get-command-invocation --command-id "$out" --instance-id "$id" \
    --query 'StandardOutputContent' --output text
}

case "${1:-}" in
  url)
    echo "Fetching the tunnel URL (retries while the tunnel comes up)..."
    for _ in $(seq 1 20); do
      u="$(run_ssm "journalctl -u unumcp-tunnel --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+[.]trycloudflare[.]com' | tail -1")"
      [ -n "${u// /}" ] && { echo "Demo URL: $u"; exit 0; }
      sleep 15
    done
    echo "Tunnel not up yet — bootstrap may still be running (check: manage.sh bootlog)." ;;
  start)
    aws ec2 start-instances --instance-ids "$(iid)" >/dev/null
    aws ec2 wait instance-running --instance-ids "$(iid)"
    echo "Started. Waiting ~30s for services + tunnel..."; sleep 30
    exec "$0" url ;;
  stop)
    aws ec2 stop-instances --instance-ids "$(iid)" >/dev/null
    echo "Stopping. Billing now ~disk only." ;;
  status)
    aws ec2 describe-instances --instance-ids "$(iid)" \
      --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress,InstanceType]' --output text ;;
  bootlog) run_ssm "tail -n 40 /var/log/unumcp-bootstrap.log" ;;
  logs)    run_ssm "journalctl -u unumcp-api -u unumcp-web -u unumcp-tunnel --no-pager -n 40" ;;
  ssh)     aws ssm start-session --target "$(iid)" ;;
  teardown)
    id="$(iid)"
    aws ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$id"
    aws ec2 delete-security-group --group-name "$SG" 2>/dev/null || true
    aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" 2>/dev/null || true
    aws iam delete-instance-profile --instance-profile-name "$ROLE" 2>/dev/null || true
    aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
    aws iam delete-role --role-name "$ROLE" 2>/dev/null || true
    echo "Torn down." ;;
  *) grep -E '^#|url|start|stop|status|bootlog|logs|ssh|teardown' "$0" | sed -n '2,12p' ;;
esac
