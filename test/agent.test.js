import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import { tokenMatches, makeHostValidator, validateTarget } from '../src/security.js';
import { queryOne, queryMany } from '../src/query.js';
import { createHandler } from '../src/server.js';

const TOKEN = 'x'.repeat(32);

test('tokenMatches', () => {
    assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(tokenMatches('Bearer nope', TOKEN), false);
    assert.equal(tokenMatches(undefined, TOKEN), false);
    assert.equal(tokenMatches(`Bearer ${TOKEN}`, ''), false);
});

test('host validator allows private/own, blocks public and non-IP', () => {
    const ok = makeHostValidator({ addresses: ['203.0.113.10'] });
    for (const h of ['127.0.0.1', '10.1.1.5', '172.20.0.1', '192.168.1.50', '203.0.113.10']) assert.equal(ok(h), true, h);
    for (const h of ['8.8.8.8', '172.32.0.1', 'example.com', '169.254.169.254', '', null, '1.2.3.4/24']) assert.equal(ok(h), false, String(h));
    assert.equal(makeHostValidator({ extraCidrs: ['203.0.113.0/24'], addresses: [] })('203.0.113.9'), true);
});

test('validateTarget', () => {
    const ok = makeHostValidator({ addresses: [] });
    assert.equal(validateTarget({ id: 1, host: '127.0.0.1', port: 16261, type: 'projectzomboid' }, ok).ok, true);
    assert.equal(validateTarget({ id: 1, host: '8.8.8.8', port: 16261, type: 'projectzomboid' }, ok).error, 'host_not_allowed');
    assert.equal(validateTarget({ id: 1, host: '127.0.0.1', port: 0, type: 'rust' }, ok).error, 'invalid_port');
    assert.equal(validateTarget({ id: 1, host: '127.0.0.1', port: 1, type: '../x' }, ok).error, 'invalid_type');
    assert.equal(validateTarget({ host: '127.0.0.1', port: 1, type: 'rust' }, ok).error, 'invalid_id');
});

test('queryOne normalises a gamedig answer and failure', async () => {
    const engine = { query: async (o) => {
        assert.equal(o.givenPortOnly, true);
        if (o.port === 1) throw new Error('Failed all 2 attempts');
        return { name: 'PZ', map: 'Muldraugh', numplayers: 3, maxplayers: 32, ping: 12, players: [{ name: 'a' }, { name: 'b' }, {}] };
    } };
    const a = await queryOne({ id: 7, host: '127.0.0.1', port: 2, type: 'projectzomboid', players: true }, { engine });
    assert.deepEqual([a.online, a.players, a.max, a.names], [true, 3, 32, ['a', 'b']]);
    const b = await queryOne({ id: 8, host: '127.0.0.1', port: 1, type: 'projectzomboid', players: false }, { engine });
    assert.equal(b.online, false);
    assert.match(b.error, /Failed/);
});

test('queryMany keeps order and honours concurrency', async () => {
    let running = 0, peak = 0;
    const engine = { query: async (o) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; return { numplayers: o.port, maxplayers: 1 }; } };
    const targets = Array.from({ length: 12 }, (_, i) => ({ id: i, host: '127.0.0.1', port: i + 1, type: 'rust', players: false }));
    const r = await queryMany(targets, { engine, concurrency: 3 });
    assert.deepEqual(r.map((x) => x.players), targets.map((t) => t.port));
    assert.ok(peak <= 3);
});

async function withServer(handler, fn) {
    const s = http.createServer((q, r) => handler(q, r));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { s.close(); }
}

test('HTTP: auth, validation and query path', async () => {
    const handler = createHandler({
        token: TOKEN,
        isAllowedHost: makeHostValidator({ addresses: [] }),
        query: async (targets) => targets.map((t) => ({ id: t.id, online: true, players: 1, max: 2 })),
    });
    await withServer(handler, async (base) => {
        const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
        assert.equal((await fetch(`${base}/healthz`)).status, 401);
        assert.equal((await fetch(`${base}/healthz`, { headers: h })).status, 200);
        const bad = await fetch(`${base}/v1/query`, { method: 'POST', headers: h, body: '{' });
        assert.equal(bad.status, 400);
        const res = await fetch(`${base}/v1/query`, { method: 'POST', headers: h, body: JSON.stringify({ targets: [
            { id: 1, host: '127.0.0.1', port: 16261, type: 'projectzomboid' },
            { id: 2, host: '8.8.8.8', port: 16261, type: 'projectzomboid' },
        ] }) });
        const body = await res.json();
        assert.equal(body.results.length, 2);
        assert.equal(body.results.find((r) => r.id === 1).online, true);
        assert.equal(body.results.find((r) => r.id === 2).error, 'host_not_allowed');
        assert.equal((await fetch(`${base}/nope`, { headers: h })).status, 404);
    });
});

test('real gamedig against a fake Source (A2S_INFO) server', async () => {
    // Minimal A2S_INFO responder (Source engine, protocol 17) to prove the real gamedig path works.
    const sock = dgram.createSocket('udp4');
    const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
    sock.on('message', (msg, rinfo) => {
        if (msg.length < 5 || msg[4] !== 0x54) return;
        const body = Buffer.concat([
            Buffer.from([0x49, 17]), cstr('Test PZ'), cstr('Muldraugh, KY'), cstr('zomboid'), cstr('Project Zomboid'),
            Buffer.from([0, 0, 5, 32, 0, 0x64, 0x6c, 0, 0]), cstr('1.0'),
        ]);
        sock.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), body]), rinfo.port, rinfo.address);
    });
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    try {
        const r = await queryOne({ id: 1, host: '127.0.0.1', port: sock.address().port, type: 'projectzomboid', players: false }, { timeoutMs: 800 });
        assert.equal(r.online, true, JSON.stringify(r));
        assert.equal(r.players, 5);
        assert.equal(r.max, 32);
    } finally { sock.close(); }
});
