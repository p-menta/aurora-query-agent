import { GameDig } from 'gamedig';

/**
 * Run one gamedig query and normalise the answer.
 * `engine` is injectable so tests do not need a game server.
 */
export async function queryOne(target, { engine = GameDig, timeoutMs = 2000 } = {}) {
    const started = Date.now();
    try {
        const r = await engine.query({
            type: target.type,
            host: target.host,
            port: target.port,
            givenPortOnly: true,
            maxRetries: 1,
            socketTimeout: timeoutMs,
            attemptTimeout: timeoutMs * 3,
            requestRules: false,
            requestPlayers: target.players,
        });

        const result = {
            id: target.id,
            online: true,
            players: Number.isFinite(r.numplayers) ? r.numplayers : (r.players?.length ?? 0),
            max: Number.isFinite(r.maxplayers) ? r.maxplayers : 0,
            map: typeof r.map === 'string' ? r.map.slice(0, 80) : '',
            name: typeof r.name === 'string' ? r.name.slice(0, 120) : '',
            version: typeof r.version === 'string' ? r.version.slice(0, 40) : '',
            ping_ms: Number.isFinite(r.ping) ? r.ping : Date.now() - started,
        };

        if (target.players && Array.isArray(r.players)) {
            result.names = r.players
                .map((p) => (typeof p?.name === 'string' ? p.name.slice(0, 64) : ''))
                .filter(Boolean)
                .slice(0, 200);
        }
        return result;
    } catch (e) {
        return {
            id: target.id,
            online: false,
            error: String(e?.message ?? e).slice(0, 120),
            ping_ms: Date.now() - started,
        };
    }
}

/** Run queries with a concurrency limit. Order of results matches input. */
export async function queryMany(targets, { concurrency = 20, ...opts } = {}) {
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= targets.length) return;
            results[i] = await queryOne(targets[i], opts);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return results;
}
