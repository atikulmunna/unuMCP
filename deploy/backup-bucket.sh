# S3 bucket for the demo box's database backups. Sourced by provision.sh and
# manage.sh, which define `aws` (with --region), REGION and ROLE.

backup_bucket_name() {
  echo "unumcp-backups-$(aws sts get-caller-identity --query Account --output text)-$REGION"
}

# Create the bucket if needed (private, backups kept 30 days) and let the box's
# role write and read backups, but never delete them: only the expiry does.
# Prints the bucket name.
ensure_backup_bucket() {
  local bucket
  bucket="$(backup_bucket_name)"
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    if [ "$REGION" = us-east-1 ]; then
      aws s3api create-bucket --bucket "$bucket" >/dev/null
    else
      aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
  fi
  aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
  aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-backups","Status":"Enabled","Filter":{"Prefix":"postgres/"},"Expiration":{"Days":30}}]}' >/dev/null
  aws iam put-role-policy --role-name "$ROLE" --policy-name unumcp-backups --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\": \"Allow\", \"Action\": [\"s3:PutObject\", \"s3:GetObject\"], \"Resource\": \"arn:aws:s3:::$bucket/postgres/*\"},
      {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$bucket\",
       \"Condition\": {\"StringLike\": {\"s3:prefix\": \"postgres/*\"}}}
    ]}" >/dev/null
  echo "$bucket"
}
