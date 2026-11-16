// Treasure Hunters: prizes, Treasure Hours and the chance of having found each prize, from the chests' own times.
// The numbers below are public information, not read from the replays: Epic publishes the odds per chest, and
// the Treasure Hour times and boosts are announced week by week. The page lets the person edit the hours.

/** Chance per chest in a normal match, as published by Epic ("1 in N"). boost: which Treasure Hour multiplier applies. */
export const PRIZES = [
    { id: 'gold', name: 'Roupa Dourada da semana', den: 1562500, boost: 'gold', scope: 'week' },
    { id: 'shop', name: 'Acesso à Loja Pirata (token)', den: 137500, boost: 'shop', scope: 'season' },
    { id: 'vehicle', name: 'Veículo e decalque da semana', den: 7813, boost: 'vehicle', scope: 'week' },
    { id: 'pickaxe', name: 'Picareta ou mochila da semana', den: 568, boost: null, scope: 'week' },
    { id: 'jam', name: 'Faixa musical da semana', den: 391, boost: null, scope: 'week' },
    { id: 'loading', name: 'Tela de carregamento da semana', den: 272, boost: null, scope: 'week' },
    { id: 'gizmo', name: 'Qualquer gizmo', den: 127, boost: null, scope: 'repeat' },
];

/** Treasure Hunters ran from 1 November to 5 December 2026. */
export const SEASON = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 6) };

/** Bump when DEFAULT_EVENTS change: a list the person never edited follows the new defaults. */
export const EVENTS_REVISION = 1;

/**
 * Treasure Hours (UTC), as reported on 16 Nov 2026. "confirmado": times and boosts announced by Epic;
 * "previsto": the usual Saturday pattern, not announced yet.
 */
export const DEFAULT_EVENTS = [
    ['2026-11-07T19:00:00Z', '2026-11-07T21:00:00Z', 7.5, 1.5, 10, 'confirmado'],
    ['2026-11-08T02:00:00Z', '2026-11-08T04:00:00Z', 10, 2, 10, 'confirmado'],
    ['2026-11-14T19:00:00Z', '2026-11-14T21:00:00Z', 7.5, 1.5, 10, 'confirmado'],
    ['2026-11-15T02:00:00Z', '2026-11-15T04:00:00Z', 7.5, 1.5, 10, 'confirmado'],
    ['2026-11-21T19:00:00Z', '2026-11-21T21:00:00Z', 7.5, 1.5, 10, 'previsto'],
    ['2026-11-22T02:00:00Z', '2026-11-22T04:00:00Z', 7.5, 1.5, 10, 'previsto'],
    ['2026-11-28T19:00:00Z', '2026-11-28T21:00:00Z', 7.5, 1.5, 10, 'previsto'],
    ['2026-11-29T02:00:00Z', '2026-11-29T04:00:00Z', 7.5, 1.5, 10, 'previsto'],
].map(([start, end, gold, shop, vehicle, status]) => ({ start: Date.parse(start), end: Date.parse(end), gold, shop, vehicle, status }));

/** Weekly prizes change on Sundays at 14:00 UTC (9 AM US Eastern), the time most guides report. */
export const DEFAULT_RESET = { day: 0, hourUtc: 14 };

/** Start (ms) of the prize week that contains `at`. */
export function weekStart(at, reset = DEFAULT_RESET) {
    const d = new Date(at);
    let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), reset.hourUtc) - ((d.getUTCDay() - reset.day + 7) % 7) * 86400000;
    if (start > at) start -= 7 * 86400000;
    return start;
}

export const eventAt = (events, at) => events.find(e => at >= e.start && at < e.end) ?? null;
export const multiplier = (prize, event) => (event && prize.boost ? Math.max(0, Number(event[prize.boost]) || 1) : 1);

/** Every own chest of these matches with its time (ms). Chests without a usable time are left out. */
export function chestTimes(matches, when, kinds = null) {
    const times = [];
    for (const m of matches) {
        const start = when(m).getTime();
        if (start <= 0) continue;
        for (const chest of m.chests ?? []) if (!kinds || kinds.includes(chest.kind)) times.push(start + 1000 * (chest.timeSeconds ?? 0));
    }
    return times.sort((a, b) => a - b);
}

/**
 * Chance of having found the prize at least once in these chests, each at its own odds (boosted inside a
 * Treasure Hour): 1 − Π(1 − multiplier / den). Also the expected number of drops (for gizmos).
 */
export function chanceOf(prize, times, events, extraBaseChests = 0) {
    let logMiss = 0, expected = 0;
    for (const at of times) {
        const p = Math.min(1, multiplier(prize, eventAt(events, at)) / prize.den);
        logMiss += Math.log1p(-p);
        expected += p;
    }
    const base = 1 / prize.den;
    logMiss += extraBaseChests * Math.log1p(-base);
    expected += extraBaseChests * base;
    return { chance: -Math.expm1(logMiss), expected };
}

/** Chests needed, from a chance already reached, to get to `target` (0–1) at a given multiplier. */
export function chestsFor(prize, target, already = 0, mult = 1) {
    if (already >= target) return 0;
    const p = Math.min(1, mult / prize.den);
    return Math.ceil((Math.log1p(-target) - Math.log1p(-already)) / Math.log1p(-p));
}

/** The events as saved (numbers in ms), or the defaults; anything malformed is dropped. */
export function readEvents(saved) {
    if (!Array.isArray(saved)) return DEFAULT_EVENTS.map(e => ({ ...e }));
    return saved.map(e => ({
        start: Number(e?.start), end: Number(e?.end),
        gold: Number(e?.gold) || 1, shop: Number(e?.shop) || 1, vehicle: Number(e?.vehicle) || 1,
        status: typeof e?.status === 'string' ? e.status : 'meu',
    })).filter(e => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start).sort((a, b) => a.start - b.start);
}
