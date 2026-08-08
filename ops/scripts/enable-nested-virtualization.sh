#!/usr/bin/env bash
#
# Turn on nested virtualization for an Agent Hub host so it can run session
# microVMs.
#
# Why this is a script and not Terraform: the `cpu_options.nested_virtualization`
# attribute landed in the Terraform AWS provider in v6.33.0, and this repo is
# pinned to `~> 5.0`. A major-version provider bump touches every resource in
# the stack — including prod — which is far more risk than a one-time,
# reversible CPU-option change deserves. Move this into `aws_instance.app` when
# the provider is upgraded for other reasons.
#
# The change requires a stop/start (not a reboot): CPU options are fixed for
# the life of a running instance. On an instance-store-free host this is safe,
# but the public IP changes unless an Elastic IP is attached — check before
# running this against anything with DNS pointed at it.
#
# Supported instance types (AWS, verified Feb 2026): C8i, M8i, R8i, C8id,
# R8id, M8id, C8i-flex, R8i-flex, M8i-flex, X8i, C7i, R7i, M7i, C7i-flex,
# M7i-flex, I7i. The dev host's m7i-flex.xlarge qualifies.
#
# Usage:
#   enable-nested-virtualization.sh --instance-id i-0abc... [--profile agenthub]
#   enable-nested-virtualization.sh --name agent-hub-sandbox --region us-east-2
#
# Idempotent: exits successfully without touching anything if the option is
# already enabled.

set -euo pipefail

INSTANCE_ID=""
NAME=""
PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_REGION:-us-east-2}"
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

aws_cli() {
  if [[ -n "${PROFILE}" ]]; then
    aws --profile "${PROFILE}" --region "${REGION}" "$@"
  else
    aws --region "${REGION}" "$@"
  fi
}

# `--nested-virtualization` only exists in AWS CLI builds newer than roughly
# v2.32. Probe for it up front: discovering the gap after the stop/start has
# already begun leaves the host powered off with nothing changed.
if ! PAGER=cat MANPAGER=cat aws ec2 modify-instance-cpu-options help 2>/dev/null \
  | grep -q -- '--nested-virtualization'; then
  cat >&2 <<EOF
error: this AWS CLI ($(aws --version 2>&1)) does not support
       'ec2 modify-instance-cpu-options --nested-virtualization'.
       Upgrade to a build that does (v2.34+ is known good):
         https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
EOF
  exit 1
fi

if [[ -z "${INSTANCE_ID}" ]]; then
  [[ -n "${NAME}" ]] || { echo "error: pass --instance-id or --name" >&2; exit 2; }
  INSTANCE_ID="$(aws_cli ec2 describe-instances \
    --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=running,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text)"
  [[ -n "${INSTANCE_ID}" && "${INSTANCE_ID}" != "None" ]] \
    || { echo "error: no running/stopped instance tagged Name=${NAME}" >&2; exit 1; }
  # More than one match means the filter is ambiguous; picking one silently
  # would enable the option on an arbitrary host.
  if [[ "$(wc -w <<<"${INSTANCE_ID}")" -gt 1 ]]; then
    echo "error: tag Name=${NAME} matches several instances: ${INSTANCE_ID}" >&2
    exit 1
  fi
fi

read -r INSTANCE_TYPE STATE CURRENT CORE_COUNT THREADS_PER_CORE <<<"$(aws_cli ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].[InstanceType,State.Name,CpuOptions.NestedVirtualization,CpuOptions.CoreCount,CpuOptions.ThreadsPerCore]' \
  --output text)"

echo "instance:      ${INSTANCE_ID}"
echo "type:          ${INSTANCE_TYPE}"
echo "state:         ${STATE}"
echo "nested virt:   ${CURRENT}"
echo "cpu:           ${CORE_COUNT} core(s) x ${THREADS_PER_CORE} thread(s)"

if [[ "${CURRENT}" == "enabled" ]]; then
  echo "==> Already enabled; nothing to do."
  exit 0
fi

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo
  echo "This will STOP ${INSTANCE_ID}, change its CPU options, and START it again."
  echo "Without an Elastic IP the public address will change."
  read -r -p "Continue? [y/N] " reply
  [[ "${reply}" == "y" || "${reply}" == "Y" ]] || { echo "aborted"; exit 1; }
fi

if [[ "${STATE}" == "running" ]]; then
  echo "==> Stopping ${INSTANCE_ID}"
  aws_cli ec2 stop-instances --instance-ids "${INSTANCE_ID}" >/dev/null
  aws_cli ec2 wait instance-stopped --instance-ids "${INSTANCE_ID}"
fi

echo "==> Enabling nested virtualization"
# --core-count and --threads-per-core are mandatory on this API even when only
# the nested-virtualization flag is changing, so echo the instance's current
# values back. Passing anything else here would silently resize the host's CPU
# allocation as a side effect of enabling a feature flag.
aws_cli ec2 modify-instance-cpu-options \
  --instance-id "${INSTANCE_ID}" \
  --core-count "${CORE_COUNT}" \
  --threads-per-core "${THREADS_PER_CORE}" \
  --nested-virtualization enabled >/dev/null

echo "==> Starting ${INSTANCE_ID}"
aws_cli ec2 start-instances --instance-ids "${INSTANCE_ID}" >/dev/null
aws_cli ec2 wait instance-running --instance-ids "${INSTANCE_ID}"

VERIFIED="$(aws_cli ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].CpuOptions.NestedVirtualization' --output text)"

echo
echo "==> nested virtualization: ${VERIFIED}"
echo "    Next: run ops/scripts/setup-firecracker-host.sh on the instance and"
echo "    confirm /dev/kvm exists. The Hub's capability probe logs the reason"
echo "    at boot if it still cannot use the microVM backend."
