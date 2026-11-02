import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

/** Constant-time bearer token check. */
export function tokenMatches(header, expected) {
    if (!expected || typeof header !== 'string') return false;
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}

function inCidr(ip, cidr) {
    const [base, bitsRaw] = cidr.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (net.isIPv4(base) === false || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const DEFAULT_RANGES = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

/** IPv4 addresses that belong to this machine (includes a public IP bound to an interface). */
export function localAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list ?? []) {
            if (i.family === 'IPv4') out.push(i.address);
        }
    }
    return out;
}

/**
 * Build a host validator. Targets must be IPv4 literals that are loopback, private, or an
 * address of this machine. This stops the agent being used as a scanner or UDP reflector.
 */
export function makeHostValidator({ extraCidrs = [], addresses = localAddresses() } = {}) {
    const ranges = [...DEFAULT_RANGES, ...extraCidrs];
    const own = new Set(addresses);
    return (host) => {
        if (typeof host !== 'string' || !net.isIPv4(host)) return false;
        if (own.has(host)) return true;
        return ranges.some((r) => inCidr(host, r));
    };
}

const TYPE_RE = /^[a-z0-9_]{1,40}$/;

/** Validate and normalise one target. Returns {ok, value|error}. */
export function validateTarget(t, isAllowedHost) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'invalid_target' };
    const id = t.id;
    if (!(typeof id === 'number' || typeof id === 'string') || String(id).length > 40) {
        return { ok: false, error: 'invalid_id' };
    }
    if (!isAllowedHost(t.host)) return { ok: false, error: 'host_not_allowed' };
    const port = Number(t.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'invalid_port' };
    if (typeof t.type !== 'string' || !TYPE_RE.test(t.type)) return { ok: false, error: 'invalid_type' };
    return {
        ok: true,
        value: { id, host: t.host, port, type: t.type, players: t.players === true },
    };
}
