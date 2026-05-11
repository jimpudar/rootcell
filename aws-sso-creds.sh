#!/usr/bin/env bash
# Export AWS SSO credentials for all required profiles and provision them on a
# remote machine over SSH.  Writes ~/.aws/credentials and ~/.aws/config using
# standard INI format with named profiles.
# Run on macOS:  ./aws-sso-creds.sh <ssh-target>
set -euo pipefail

INSTANCE="agent"

SSO_SESSION="rvbd"
DEFAULT_REGION="us-east-1"

PROFILES=(
)

# --- SSO session check --------------------------------------------------

sso_session_valid() {
  aws sts get-caller-identity --profile "${PROFILES[0]}" >/dev/null 2>&1
}

if ! sso_session_valid; then
  echo "SSO session expired or missing — logging in via sso-session ${SSO_SESSION}…"
  aws sso login --sso-session "$SSO_SESSION"
  if ! sso_session_valid; then
    echo "ERROR: SSO login failed." >&2
    exit 1
  fi
  echo "SSO login succeeded."
else
  echo "SSO session is valid."
fi

# --- Collect credentials -------------------------------------------------

creds_ini=""
config_ini=""

for profile in "${PROFILES[@]}"; do
  account_id=$(aws sts get-caller-identity --profile "$profile" --query 'Account' --output text 2>/dev/null) ||
    {
      echo "ERROR: could not resolve account ID for profile '${profile}'" >&2
      exit 1
    }

  raw=$(aws configure export-credentials --profile "$profile" --format env 2>/dev/null) ||
    {
      echo "ERROR: could not export credentials for profile '${profile}'" >&2
      exit 1
    }

  access_key=$(printf '%s\n' "$raw" | grep AWS_ACCESS_KEY_ID | sed 's/^export AWS_ACCESS_KEY_ID=//')
  secret_key=$(printf '%s\n' "$raw" | grep AWS_SECRET_ACCESS_KEY | sed 's/^export AWS_SECRET_ACCESS_KEY=//')
  session_token=$(printf '%s\n' "$raw" | grep AWS_SESSION_TOKEN | sed 's/^export AWS_SESSION_TOKEN=//')

  creds_ini+="# account ${account_id}"$'\n'
  creds_ini+="[${profile}]"$'\n'
  creds_ini+="aws_access_key_id = ${access_key}"$'\n'
  creds_ini+="aws_secret_access_key = ${secret_key}"$'\n'
  creds_ini+="aws_session_token = ${session_token}"$'\n'
  creds_ini+=$'\n'

  config_ini+="[profile ${profile}]"$'\n'
  config_ini+="region = ${DEFAULT_REGION}"$'\n'
  config_ini+="output = json"$'\n'
  config_ini+=$'\n'
done

output="mkdir -p ~/.aws"
output+=$'\n'

output+="cat > ~/.aws/credentials << 'AWS_CREDS'"
output+=$'\n'
output+="${creds_ini}AWS_CREDS"
output+=$'\n'

output+="cat > ~/.aws/config << 'AWS_CONFIG'"
output+=$'\n'
output+="${config_ini}AWS_CONFIG"
output+=$'\n'

# --- Provision via SSH ----------------------------------------------------

echo ""
echo "Provisioning ${#PROFILES[@]} profile(s) on ${INSTANCE}…"
printf '%s\n' "$output" | limactl shell "$INSTANCE" bash
echo ""
echo "Done — credentials written on ${INSTANCE} for:"
for profile in "${PROFILES[@]}"; do
  echo "  • ${profile}"
done
