// Docker health check. Exit 0 only when the agent answers /healthz with 200.
// Uses HTTPS when TLS is configured. The cert is for the node FQDN, so it is not verified on localhost.
import http from 'node:http';
import https from 'node:https';

const tls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const lib = tls ? https : http;
const req = lib.get({
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 8443),
    path: '/healthz',
    headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN ?? ''}` },
    rejectUnauthorized: false,
    timeout: 4000,
}, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
