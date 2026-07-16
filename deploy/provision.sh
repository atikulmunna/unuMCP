#!/bin/bash
# One-shot AWS provisioner for the unuMCP demo box. Creates an SSM-managed
# t4g.small (zero inbound ports), injects secrets via user-data at launch only
# (never committed), and lets the box bootstrap itself. Idempotent-ish: reuses
# the SG / IAM role if they already exist.
#
#   bash deploy/provision.sh
#
# Requires: AWS CLI authenticated, and GEMINI_API_KEY present in apps/api/.env.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME=unumcp
TYPE="${INSTANCE_TYPE:-t4g.small}"
VOLUME_GB="${VOLUME_GB:-20}"
ROLE=unumcp-ssm-role
SG=unumcp-sg
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { echo "==> $*"; }
aws() { command aws --region "$REGION" "$@"; }

# --- secrets (read locally, never written to the repo) ---
ENV_FILE="$ROOT/apps/api/.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (need GEMINI_API_KEY)"; exit 1; }
GEMINI_API_KEY="$(grep -E '^GEMINI_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"'"'"' ' )"
[ -n "$GEMINI_API_KEY" ] || { echo "GEMINI_API_KEY not set in $ENV_FILE"; exit 1; }
JWT_SECRET="$(openssl rand -hex 32)"
DB_PASSWORD="$(openssl rand -hex 16)"

# --- AMI ---
say "Resolving latest Amazon Linux 2023 arm64 AMI..."
AMI="$(aws ec2 describe-images --owners amazon \
  --filters 'Name=name,Values=al2023-ami-2023.*-arm64' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
say "AMI: $AMI"

# --- IAM role + instance profile for SSM Session Manager ---
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  say "Creating IAM role $ROLE (SSM)..."
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  say "Waiting for the instance profile to propagate..."; sleep 15
fi

# --- security group: no inbound, egress all (default) ---
VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SUBNET="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)"
SG_ID="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  say "Creating security group $SG (no inbound rules)..."
  SG_ID="$(aws ec2 create-security-group --group-name "$SG" --vpc-id "$VPC" \
    --description 'unuMCP demo (no inbound; SSM + tunnel are outbound only)' --query GroupId --output text)"
fi
say "Security group: $SG_ID"

# --- user-data: secret preamble + committed bootstrap body ---
USERDATA="$(mktemp)"; trap 'rm -f "$USERDATA"' EXIT
{
  echo '#!/bin/bash'
  echo "export GEMINI_API_KEY='$GEMINI_API_KEY'"
  echo "export JWT_SECRET='$JWT_SECRET'"
  echo "export DB_PASSWORD='$DB_PASSWORD'"
  tail -n +2 "$ROOT/deploy/bootstrap.sh"
} > "$USERDATA"

# On Windows/git-bash the native aws.exe can't read an MSYS /tmp path — translate it.
UD_REF="file://$USERDATA"
if command -v cygpath >/dev/null 2>&1; then UD_REF="file://$(cygpath -w "$USERDATA")"; fi

say "Launching $TYPE ..."
IID="$(aws ec2 run-instances \
  --image-id "$AMI" --instance-type "$TYPE" --subnet-id "$SUBNET" \
  --security-group-ids "$SG_ID" --iam-instance-profile "Name=$ROLE" \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled' \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$VOLUME_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "$UD_REF" \
  --query 'Instances[0].InstanceId' --output text)"

say "Instance launched: $IID"
aws ec2 wait instance-running --instance-ids "$IID"
say "Instance is running. Bootstrap (install + build) takes ~8-10 min."
say "Get the demo URL when ready:   bash deploy/manage.sh url"
say "Follow bootstrap progress:     bash deploy/manage.sh bootlog"
