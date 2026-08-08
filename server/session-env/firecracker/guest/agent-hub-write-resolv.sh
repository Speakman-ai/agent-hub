#!/bin/sh
# Write /etc/resolv.conf from `agenthub.dns=<ip>[,<ip>...]` on the kernel
# cmdline. Absent or malformed, the image's baked-in default is left alone —
# a guest with imperfect DNS is recoverable, one with none is not.
set -eu

dns=''
# shellcheck disable=SC2013 # /proc/cmdline is one line of space-separated
# parameters, so word splitting is the intended read, not an accident.
for param in $(cat /proc/cmdline); do
  case "$param" in
    agenthub.dns=*) dns="${param#agenthub.dns=}" ;;
  esac
done

[ -n "$dns" ] || exit 0

tmp="$(mktemp)"
wrote=0
# `IFS=,` splits the comma list without invoking a subshell that would lose
# the counter (a `while read` pipeline runs in a subshell in dash).
IFS=','
for server in $dns; do
  case "$server" in
    '' | *[!0-9.:a-fA-F]*) continue ;;
  esac
  echo "nameserver $server" >>"$tmp"
  wrote=$((wrote + 1))
done
unset IFS

if [ "$wrote" -eq 0 ]; then
  rm -f "$tmp"
  exit 0
fi

echo 'options timeout:2 attempts:2' >>"$tmp"
cat "$tmp" >/etc/resolv.conf
rm -f "$tmp"
chmod 0644 /etc/resolv.conf
