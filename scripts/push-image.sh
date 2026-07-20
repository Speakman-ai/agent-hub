#!/usr/bin/env bash
# Build + push the agent-hub server image to ECR Public from a dev laptop.
#
# Requires:
#   - Docker daemon running
#   - AWS CLI configured with SSO creds (e.g. AWS_PROFILE=dev) for the account
#     that owns the ECR Public repo below
#   - Run from the repo root
#
# Usage:
#   AWS_PROFILE=dev scripts/push-image.sh              # tags :<short-sha> + :<branch>
#   AWS_PROFILE=dev scripts/push-image.sh --tag rc1    # adds :rc1 on top of the above
#
# The GitHub Actions workflow (.github/workflows/push-image.yml) does the same
# thing on every merge to main; this script is for one-off out-of-band pushes
# (hotfixes, testing a Dockerfile change before opening a PR, etc).

set -euo pipefail

REGION="us-east-1"                           # ECR Public API is us-east-1
ECR_URI="public.ecr.aws/h9t4v7h0/agent-hub"  # Alias + repo; update here if the
                                             # vanity alias "agenthub" is ever approved

EXTRA_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) EXTRA_TAG="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found in PATH" >&2
  exit 1
fi

SHA_SHORT="$(git rev-parse --short=12 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "→ Logging in to ECR Public (${REGION})..."
aws ecr-public get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin public.ecr.aws >/dev/null

echo "→ Building image (linux/amd64)..."
docker buildx build \
  --platform linux/amd64 \
  -f server/Dockerfile \
  -t "${ECR_URI}:${SHA_SHORT}" \
  -t "${ECR_URI}:${BRANCH}" \
  ${EXTRA_TAG:+-t "${ECR_URI}:${EXTRA_TAG}"} \
  --load \
  .

echo "→ Pushing ${ECR_URI}:${SHA_SHORT} ..."
docker push "${ECR_URI}:${SHA_SHORT}"
echo "→ Pushing ${ECR_URI}:${BRANCH} ..."
docker push "${ECR_URI}:${BRANCH}"
if [[ -n "$EXTRA_TAG" ]]; then
  echo "→ Pushing ${ECR_URI}:${EXTRA_TAG} ..."
  docker push "${ECR_URI}:${EXTRA_TAG}"
fi

echo
echo "✓ Pushed:"
echo "    ${ECR_URI}:${SHA_SHORT}"
echo "    ${ECR_URI}:${BRANCH}"
[[ -n "$EXTRA_TAG" ]] && echo "    ${ECR_URI}:${EXTRA_TAG}"
echo
echo "Pull anywhere (public repo, no login needed):"
echo "    docker pull ${ECR_URI}:${SHA_SHORT}"
