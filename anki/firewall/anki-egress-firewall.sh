#!/bin/sh
# Lets the headless Anki container reach the public internet (AnkiWeb) and nothing
# else: no LAN, no tailnet, no Docker networks, no services on the Pi itself.
# Idempotent; run after Docker has started (see anki-egress-firewall.service).
set -eu
SUBNET=172.30.99.0/24
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }

# Forwarded traffic (to other hosts / containers). DOCKER-USER is evaluated first.
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4; do
  add DOCKER-USER -s "$SUBNET" -d "$dst" -j REJECT
done
# Traffic to the Pi's own addresses (LAN IP, tailnet IP, bridge gateway) hits INPUT.
add INPUT -s "$SUBNET" -j REJECT
