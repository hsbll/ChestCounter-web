// Minimal ZIP reader: lists the .replay files of an archive and unpacks them one at a time, straight from the
// File on disk (the archive is never loaded whole). Stored and deflated entries, ZIP64 included; no encryption.
const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOCATOR64 = 0x07064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

const view = async blob => new DataView(await blob.arrayBuffer());
const u64 = (data, offset) => Number(data.getBigUint64(offset, true));

function dosDate(date, time) {
    const stamp = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
    return Number.isFinite(stamp) ? stamp : 0;
}

/** Returns [{ name, path, size, key, lastModified, getFile() }] for every .replay file in the archive. */
export async function listReplays(zip) {
    const tailSize = Math.min(zip.size, 65557);
    const tailStart = zip.size - tailSize;
    const tail = await view(zip.slice(tailStart));
    let end = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === EOCD) { end = i; break; }
    }
    if (end < 0) throw new Error('não é um arquivo .zip válido');

    let count = tail.getUint16(end + 10, true);
    let size = tail.getUint32(end + 12, true);
    let offset = tail.getUint32(end + 16, true);
    if (count === 0xFFFF || size === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
        if (end < 20 || tail.getUint32(end - 20, true) !== LOCATOR64) throw new Error('zip grande demais (ZIP64 incompleto)');
        const record = await view(zip.slice(u64(tail, end - 12), u64(tail, end - 12) + 56));
        if (record.byteLength < 56 || record.getUint32(0, true) !== EOCD64) throw new Error('zip corrompido (ZIP64)');
        count = u64(record, 32);
        size = u64(record, 40);
        offset = u64(record, 48);
    }

    const central = await view(zip.slice(offset, offset + size));
    const utf8 = new TextDecoder('utf-8');
    const entries = [];
    let at = 0;
    for (let n = 0; n < count && at + 46 <= central.byteLength; n++) {
        if (central.getUint32(at, true) !== CENTRAL) throw new Error('zip corrompido (diretório central)');
        const flags = central.getUint16(at + 8, true);
        const method = central.getUint16(at + 10, true);
        const crc = central.getUint32(at + 16, true);
        let packed = central.getUint32(at + 20, true);
        let unpacked = central.getUint32(at + 24, true);
        const nameLength = central.getUint16(at + 28, true);
        const extraLength = central.getUint16(at + 30, true);
        const commentLength = central.getUint16(at + 32, true);
        let local = central.getUint32(at + 42, true);
        const path = utf8.decode(new Uint8Array(central.buffer, central.byteOffset + at + 46, nameLength));

        // ZIP64: the real values replace, in this order, each field that holds 0xFFFFFFFF.
        for (let e = at + 46 + nameLength, stop = e + extraLength; e + 4 <= stop;) {
            const id = central.getUint16(e, true), length = central.getUint16(e + 2, true);
            if (id === 1) {
                let p = e + 4;
                if (unpacked === 0xFFFFFFFF) { unpacked = u64(central, p); p += 8; }
                if (packed === 0xFFFFFFFF) { packed = u64(central, p); p += 8; }
                if (local === 0xFFFFFFFF) { local = u64(central, p); }
            }
            e += 4 + length;
        }

        const lastModified = dosDate(central.getUint16(at + 14, true), central.getUint16(at + 12, true));
        at += 46 + nameLength + extraLength + commentLength;
        if (path.endsWith('/') || path.startsWith('__MACOSX/') || !/\.replay$/i.test(path)) continue;

        const name = path.slice(path.lastIndexOf('/') + 1);
        entries.push({
            name, path, size: unpacked, lastModified,
            // Same replay in another zip (or zipped again) is recognised: name, size and checksum of the content.
            key: `${name}|${unpacked}|crc${crc.toString(16)}`,
            getFile: async () => {
                if (flags & 1) throw new Error('zip protegido por senha');
                const header = await view(zip.slice(local, local + 30));
                if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) throw new Error('zip corrompido (entrada)');
                const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
                let data = zip.slice(start, start + packed);
                if (method === 8) {
                    if (typeof DecompressionStream !== 'function') throw new Error('este navegador não descompacta zip; extraia os arquivos antes');
                    data = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
                } else if (method !== 0) {
                    throw new Error(`compressão de zip não suportada (método ${method})`);
                }
                if (data.size !== unpacked) throw new Error('zip corrompido (tamanho diferente do esperado)');
                return new File([data], name, { lastModified });
            },
        });
    }
    return entries;
}
