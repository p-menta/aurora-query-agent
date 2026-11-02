#!/bin/sh
# Let's Encrypt deploy hook for the aurora-query-agent.
# The cert files in /etc/letsencrypt are root-only. The agent runs as UID 1000 (user "node"),
# so this hook copies them to a folder that UID can read. The agent reloads them every hour.
#
# Install on the node (needs root, one time):
#   install -m 0755 deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/aurora-query-agent.sh
#   AGENT_FQDN=node.example.com sh deploy-hook.sh      # first copy, run once by hand
#
# Certbot gives $RENEWED_LINEAGE when it runs this as a hook; by hand we use AGENT_FQDN.
set -eu
FQDN="${AGENT_FQDN:-}"
SRC="${RENEWED_LINEAGE:-/etc/letsencrypt/live/${FQDN}}"
DST="${AGENT_CERT_DIR:-/etc/aurora-query-agent/certs}"

# Only act on the lineage that belongs to this node (a hook runs for every renewed cert).
if [ -n "${RENEWED_LINEAGE:-}" ] && [ -n "$FQDN" ] && [ "$(basename "$RENEWED_LINEAGE")" != "$FQDN" ]; then
    exit 0
fi

[ -d "$SRC" ] || { echo "cert folder $SRC not found" >&2; exit 1; }
install -d -m 0750 -o 1000 -g 1000 "$DST"
install -m 0640 -o 1000 -g 1000 "$SRC/fullchain.pem" "$DST/fullchain.pem"
install -m 0640 -o 1000 -g 1000 "$SRC/privkey.pem" "$DST/privkey.pem"
echo "aurora-query-agent: cert copied to $DST"
