import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tokenMatches, makeHostValidator, validateTarget } from './security.js';
import { queryMany } from './query.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const MAX_BODY = 256 * 1024;
const MAX_TARGETS = 500;

export function createHandler({ token, isAllowedHost, query = queryMany, concurrency = 20, timeoutMs = 2000 }) {
    const json = (res, status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
        res.end(data);
    };

    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');

        if (!tokenMatches(req.headers.authorization, token)) {
            return json(res, 401, { error: 'unauthorized' });
        }

        if (req.method === 'GET' && url.pathname === '/healthz') {
            return json(res, 200, { ok: true, version: VERSION, uptime_s: Math.round(process.uptime()) });
        }

        if (req.method === 'POST' && url.pathname === '/v1/query') {
            let size = 0;
            const chunks = [];
            for await (const c of req) {
                size += c.length;
                if (size > MAX_BODY) return json(res, 413, { error: 'body_too_large' });
                chunks.push(c);
            }

            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return json(res, 400, { error: 'invalid_json' });
            }
            if (!Array.isArray(body?.targets) || body.targets.length > MAX_TARGETS) {
                return json(res, 400, { error: 'invalid_targets' });
            }

            const valid = [];
            const results = [];
            for (const t of body.targets) {
                const v = validateTarget(t, isAllowedHost);
                if (v.ok) valid.push(v.value);
                else results.push({ id: t?.id ?? null, online: false, error: v.error });
            }

            const started = Date.now();
            const answered = await query(valid, { concurrency, timeoutMs });
            return json(res, 200, {
                version: VERSION,
                duration_ms: Date.now() - started,
                results: [...answered, ...results],
            });
        }

        return json(res, 404, { error: 'not_found' });
    };
}

function main() {
    const token = process.env.AGENT_TOKEN;
    if (!token || token.length < 24) {
        console.error('AGENT_TOKEN is required and must have at least 24 characters.');
        process.exit(1);
    }

    const port = Number(process.env.PORT ?? 8443);
    const bind = process.env.BIND ?? '0.0.0.0';
    const extra = (process.env.ALLOWED_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const handler = createHandler({
        token,
        isAllowedHost: makeHostValidator({ extraCidrs: extra }),
        concurrency: Number(process.env.CONCURRENCY ?? 20),
        timeoutMs: Number(process.env.QUERY_TIMEOUT_MS ?? 2000),
    });
    const onRequest = (req, res) => handler(req, res).catch((e) => {
        console.error('request failed', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
    });

    const certPath = process.env.TLS_CERT;
    const keyPath = process.env.TLS_KEY;
    let server;
    if (certPath && keyPath) {
        const load = () => ({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) });
        server = https.createServer(load(), onRequest);
        // Let's Encrypt renews every ~60 days: reload the files every hour, no restart needed.
        setInterval(() => {
            try { server.setSecureContext(load()); } catch (e) { console.error('cert reload failed', e.message); }
        }, 3600_000).unref();
    } else {
        console.warn('TLS_CERT/TLS_KEY not set: serving plain HTTP. Use only on a private network.');
        server = http.createServer(onRequest);
    }
    server.requestTimeout = 30_000;
    server.listen(port, bind, () => console.log(`aurora-query-agent ${VERSION} listening on ${bind}:${port}`));
}

const isEntry = (() => {
    try {
        return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();
if (isEntry) main();
