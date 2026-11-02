# aurora-query-agent

Stateless game query executor. The Aurora panel sends a list of targets. The agent queries them
in parallel with [gamedig](https://github.com/gamedig/node-gamedig) and returns the results.
It stores nothing and knows no server list.

## API (all calls need `Authorization: Bearer <AGENT_TOKEN>`)

- `GET /healthz` → `{ok, version, uptime_s}`
- `POST /v1/query` body `{"targets":[{"id":12,"host":"192.168.1.50","port":16261,"type":"projectzomboid","players":true}]}`
  → `{"version","duration_ms","results":[{"id":12,"online":true,"players":3,"max":32,"map":"…","name":"…","ping_ms":14,"names":["a"]}]}`
  An offline or invalid target gives `{"id":12,"online":false,"error":"…"}`.

## Safety

- Targets must be IPv4 literals: loopback, private ranges, or an address of this machine. Everything else is refused (`host_not_allowed`).
- Max 500 targets and 256 KB per request. Constant-time token check.
- The container drops all capabilities, has a read-only file system, 128 MB RAM and 0.25 CPU.
- It only sends small query packets. It never touches Wings or game containers.

## Install on a node (needs approval on production)

```sh
mkdir -p /opt/aurora-query-agent && cd /opt/aurora-query-agent
# copy the project files here, then:
# 1. Cert copy. The Let's Encrypt files are root-only, the agent runs as UID 1000.
AGENT_FQDN=node.example.com sh deploy-hook.sh
install -m 0755 deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/aurora-query-agent.sh
#    (put AGENT_FQDN in that hook, or export it in the certbot environment)
# 2. Config and start.
cp .env.example .env && nano .env          # set AGENT_TOKEN
docker compose up -d --build
docker ps --filter name=aurora-query-agent  # STATUS must become "healthy"
curl -sk -H "Authorization: Bearer $AGENT_TOKEN" https://node.example.com:8443/healthz
```

Open the agent port in the node firewall for the panel IP only (PANEL_IP).
Check first that the port is free: `ss -tlnp | grep 8443`.
Remove it any time: `docker compose down`.

## Test

`npm test` (includes a real gamedig run against a fake A2S server).

## Image

GitHub Actions tests the code, scans the image with Trivy (fails on HIGH/CRITICAL) and pushes
`ghcr.io/<owner>/aurora-query-agent` (linux/amd64, with SBOM and provenance). On a node:

```sh
echo 'AGENT_IMAGE=ghcr.io/<owner>/aurora-query-agent:1.0.0' >> .env   # pin a version, not "latest"
docker compose pull && docker compose up -d
```

Without the variable, compose builds the image locally from the Dockerfile.
This repo holds no secrets and no infrastructure details. Tokens are set only in each node's `.env`.
