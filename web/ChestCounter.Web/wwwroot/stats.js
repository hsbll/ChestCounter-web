// Same figures as the desktop tool (Profiles.cs / Monitor.cs), computed from the saved matches.
export const CHEST_KINDS = ['Chest', 'Rare chest', 'Buried chest', 'Extraction / relic chest', 'Spirit poster chest', 'Other chest'];
export const AMMO = 'Ammo box', FOOD = 'Food box', CANNON = 'Loot cannon';

/** The analyzer writes UTC times, some without the final "Z". */
function utc(text) {
    return typeof text === 'string' && !/(Z|[+-]\d\d:\d\d)$/.test(text) ? text + 'Z' : text;
}
export function when(m) {
    const date = new Date(utc(m.matchStartUtc ?? m.analyzedAtUtc));
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}
export const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const profileKey = m => m.epicId || m.playerName || '';

/** Team size of a playlist: 'solo', 'duo', 'trio', 'squad' or '' when the name does not say. */
export function teamSize(playlist) {
    const p = (playlist ?? '').toLowerCase();
    return p.includes('solo') ? 'solo' : p.includes('duo') ? 'duo' : p.includes('trio') ? 'trio' : p.includes('squad') ? 'squad' : '';
}

export function extraKinds(settings) {
    const kinds = [];
    if (settings.countAmmo) kinds.push(AMMO);
    if (settings.countFood) kinds.push(FOOD);
    if (settings.countCannons) kinds.push(CANNON);
    return kinds;
}

const interactions = (m, kind) => {
    const other = m.otherInteractions ?? {};
    return Object.keys(other).length > 0 ? (other[kind] ?? 0) : kind === AMMO ? (m.ammoBoxesOpened ?? 0) : 0;
};
export const mateSeen = (mate, kinds) => (mate.chestsSeen ?? 0) + kinds.reduce((sum, k) => sum + (mate.kinds?.[k] ?? 0), 0);

/** Chests of a match as shown: own chests, plus the extra kinds and (if chosen) what the teammates were seen opening. */
export function counts(m, settings) {
    const kinds = extraKinds(settings);
    const own = (m.chestsOpened ?? 0) + kinds.reduce((sum, k) => sum + interactions(m, k), 0);
    const mates = (m.teammates ?? []).reduce((sum, t) => sum + mateSeen(t, kinds), 0);
    return { own, mates, total: own + (settings.countTeammates ? mates : 0) };
}

export function profiles(data) {
    const groups = new Map();
    for (const entry of Object.values(data.matches)) {
        if (!entry.supported && !data.settings.includeOld) continue;
        const key = profileKey(entry.match);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry.match);
    }
    return [...groups.entries()].map(([key, matches]) => {
        matches.sort((a, b) => when(b) - when(a));
        return {
            key,
            name: matches.map(m => m.playerName).find(n => n && n.trim()) ?? 'Conta desconhecida',
            matches,
            lastPlayed: when(matches[0]),
        };
    }).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

export function currentProfile(data) {
    const all = profiles(data);
    return all.find(p => p.key === data.settings.profile) ?? all[0] ?? null;
}

/** First instant of a period filter ('all', 'today', '7', '30', 'month', 'year'), or null for no limit. */
export function periodStart(period, now = new Date()) {
    const day = offset => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    switch (period) {
        case 'today': return day(0);
        case '7': return day(6);
        case '30': return day(29);
        case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
        case 'year': return new Date(now.getFullYear(), 0, 1);
        default: return null;
    }
}

/**
 * filter = { period, size }: only the matches of that period and team size are counted. The chests "from before
 * the counter" belong to no match, so they are only added when nothing is filtered out.
 */
export function build(data, filter = {}, now = new Date()) {
    const settings = data.settings;
    const profile = currentProfile(data);
    const start = periodStart(filter.period, now);
    const filtered = !!start || !!filter.size;
    const all = profile?.matches ?? []; // newest first
    const matches = all.filter(m => (!start || when(m) >= start) && (!filter.size || teamSize(m.playlist) === filter.size));
    const rows = matches.map(m => ({ m, date: when(m), ...counts(m, settings) }));

    const perDay = new Map();
    for (const row of rows) {
        const key = dayKey(row.date);
        perDay.set(key, (perDay.get(key) ?? 0) + row.total);
    }
    let bestDay = null;
    for (const [key, chests] of perDay) {
        if (!bestDay || chests > bestDay.chests) bestDay = { key, chests };
    }

    const lastDays = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        lastDays.push({ date, chests: perDay.get(dayKey(date)) ?? 0 });
    }

    const byKind = new Map();
    const others = new Map();
    const treasures = [];
    const mates = new Map();
    for (const { m, date } of rows) {
        for (const chest of m.chests ?? []) byKind.set(chest.kind, (byKind.get(chest.kind) ?? 0) + 1);
        for (const [kind, n] of Object.entries(m.otherInteractions ?? {})) others.set(kind, (others.get(kind) ?? 0) + n);
        for (const find of m.treasureFinds ?? []) treasures.push({ find, m, date });
        for (const mate of m.teammates ?? []) {
            const key = mate.epicId || mate.name;
            const entry = mates.get(key) ?? { name: mate.name, matches: 0, wins: 0, seen: 0, best: 0 };
            const seen = mateSeen(mate, extraKinds(settings));
            entry.name = entry.name || mate.name;
            entry.matches++;
            entry.seen += seen;
            entry.best = Math.max(entry.best, seen);
            if (m.placement === 1) entry.wins++;
            mates.set(key, entry);
        }
    }

    const sum = rows.reduce((total, row) => total + row.total, 0);
    const initial = filtered ? 0 : Math.max(0, settings.initialChests?.[profile?.key ?? ''] ?? 0);
    const placed = rows.filter(row => row.m.placement != null);
    return {
        profile,
        filtered,
        available: all.length,
        sizes: [...new Set(all.map(m => teamSize(m.playlist)).filter(Boolean))],
        rows,
        total: sum + initial,
        initial,
        matches: rows.length,
        average: rows.length ? sum / rows.length : 0,
        bestMatch: rows.reduce((best, row) => Math.max(best, row.total), 0),
        today: perDay.get(dayKey(now)) ?? 0,
        bestDay,
        wins: placed.filter(row => row.m.placement === 1).length,
        top10: placed.filter(row => row.m.placement <= 10).length,
        placed: placed.length,
        teamChests: rows.reduce((total, row) => total + row.mates, 0),
        // Oldest match with a known date (a record without one sorts last, at 1970).
        since: rows.filter(row => row.date.getTime() > 0).at(-1)?.date ?? null,
        lastDays,
        byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
        others: [...others.entries()].sort((a, b) => b[1] - a[1]),
        treasures,
        mates: [...mates.values()].sort((a, b) => b.seen - a.seen),
    };
}

/**
 * The teammate's own record of the same match, when their replay was added too (same session, their account):
 * their exact chest count instead of the minimum seen from this player's replay.
 */
export function teammateRecord(data, match, mate) {
    if (!mate.epicId) return null;
    return Object.values(data.matches).map(e => e.match).find(m => m.sessionId === match.sessionId && m.epicId === mate.epicId) ?? null;
}
