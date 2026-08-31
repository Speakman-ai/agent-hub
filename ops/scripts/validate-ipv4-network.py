#!/usr/bin/env python3
"""Validate and canonicalize an IPv4 network-base CIDR for the docker daemon's
default-address-pools.

Loose string checks (digits-and-dots globs) let malformed values such as
``999.999.999.999/9`` or a host-address form pass, get written into
``/etc/docker/daemon.json``, and then wedge ``systemctl restart docker`` after
the live config has already been replaced. This uses Python's ``ipaddress``
parser so every reject happens BEFORE the daemon config is touched:

* octets out of 0-255 range      -> reject
* prefix length out of 0-32      -> reject
* host bits set (not a base)     -> reject (``strict=True``)
* non-IPv4 (e.g. IPv6)           -> reject

On success it prints the canonical ``network/prefix`` (so daemon.json always
records a normalized base) and exits 0; on any invalid input it writes a
message to stderr and exits non-zero.

Consumed by ops/scripts/setup-sysbox-host.sh; unit-tested in
server/setup-sysbox-daemon-json.test.ts.
"""

import ipaddress
import sys


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: validate-ipv4-network.py <cidr>\n")
        return 2
    raw = sys.argv[1]
    if "/" not in raw:
        # An address pool needs an explicit supernet prefix; a bare address
        # would otherwise be accepted as /32 (zero usable subnets).
        sys.stderr.write("needs an explicit /prefix, e.g. 10.128.0.0/9\n")
        return 1
    try:
        net = ipaddress.ip_network(raw, strict=True)
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    if net.version != 4:
        sys.stderr.write("must be an IPv4 network base (e.g. 10.128.0.0/9)\n")
        return 1
    print(net.with_prefixlen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
