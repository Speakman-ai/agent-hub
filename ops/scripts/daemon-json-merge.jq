# Merge the sysbox-runc runtime — and, when $base is a non-empty CIDR, a widened
# default-address-pools entry — into an existing /etc/docker/daemon.json, leaving
# all other keys untouched. Consumed by setup-sysbox-host.sh and unit-tested in
# server/setup-sysbox-daemon-json.test.ts. Inputs: $base (CIDR string or ""),
# $size (integer prefix length for each carved subnet, e.g. 24).
# Add the sysbox-runc runtime ONLY when it is absent. An operator may have
# customized an existing entry (custom `path`, `runtimeArgs`, …); overwriting it
# on a default-off rerun would discard that config and restart Docker with the
# altered definition. Preserve any existing entry untouched.
(if .runtimes["sysbox-runc"] == null
   then .runtimes["sysbox-runc"] = { "path": "/usr/bin/sysbox-runc" }
   else . end)
| if $base != "" then .["default-address-pools"] = [ { "base": $base, "size": $size } ] else . end
