const fs = require('fs');
const path = require('path');

module.exports = function createZip(root, limits) {
    async function collectFiles(folder, prefix, files, total, depth = 0) {
        if (depth > limits.maxFolderDepth) throw new Error('pasta_grande_demais');

        const entries = await fs.promises.readdir(folder, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === '.tmp') continue;
            if (entry.isSymbolicLink()) continue;
            if (files.length >= limits.maxZipFiles) throw new Error('pasta_grande_demais');

            const full = path.join(folder, entry.name);
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                await collectFiles(full, name, files, total, depth + 1);
                continue;
            }

            if (!entry.isFile()) continue;

            const stat = await fs.promises.stat(full);
            if (stat.size > 0xFFFFFFFF) throw new Error('arquivo_muito_grande_para_zip');

            total.bytes += stat.size;
            if (total.bytes > limits.maxZipBytes) throw new Error('zip_grande_demais');

            files.push({
                path: full,
                name,
                size: stat.size,
                time: stat.mtime
            });
        }
    }

    function u16(value) {
        const buffer = Buffer.allocUnsafe(2);
        buffer.writeUInt16LE(value & 0xFFFF, 0);
        return buffer;
    }

    function u32(value) {
        const buffer = Buffer.allocUnsafe(4);
        buffer.writeUInt32LE(value >>> 0, 0);
        return buffer;
    }

    function makeCrcTable() {
        const table = new Uint32Array(256);

        for (let i = 0; i < table.length; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1
                    ? 0xEDB88320 ^ (value >>> 1)
                    : value >>> 1;
            }
            table[i] = value >>> 0;
        }

        return table;
    }

    const crcTable = makeCrcTable();

    function crc32(buffer, previous = 0) {
        let crc = (~previous) >>> 0;

        for (let i = 0; i < buffer.length; i++) {
            crc = crcTable[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
        }

        return (~crc) >>> 0;
    }

    function dosDate(value) {
        const date = value instanceof Date ? value : new Date(value);
        const year = Math.max(1980, date.getFullYear());

        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
        };
    }

    async function write(res, chunk) {
        if (res.write(chunk)) return;

        await new Promise((resolve, reject) => {
            function done() {
                res.off('error', failed);
                resolve();
            }

            function failed(error) {
                res.off('drain', done);
                reject(error);
            }

            res.once('drain', done);
            res.once('error', failed);
        });
    }

    async function send(res, folder) {
        const files = [];
        await collectFiles(folder, path.basename(folder), files, { bytes: 0 });

        if (files.length > 65535) throw new Error('pasta_grande_demais');

        const central = [];
        let offset = 0;

        for (const file of files) {
            const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
            if (name.length > 65535) throw new Error('nome_grande_demais');

            const date = dosDate(file.time);
            const start = offset;
            const header = Buffer.concat([
                u32(0x04034B50),
                u16(20),
                u16(0x0008),
                u16(0),
                u16(date.time),
                u16(date.date),
                u32(0),
                u32(file.size),
                u32(file.size),
                u16(name.length),
                u16(0),
                name
            ]);

            await write(res, header);
            offset += header.length;

            let crc = 0;

            await new Promise((resolve, reject) => {
                const input = fs.createReadStream(file.path, { highWaterMark: 1024 * 1024 });

                input.on('data', async chunk => {
                    input.pause();
                    try {
                        crc = crc32(chunk, crc);
                        await write(res, chunk);
                        input.resume();
                    } catch (error) {
                        input.destroy();
                        reject(error);
                    }
                });

                input.on('end', resolve);
                input.on('error', reject);
            });

            const descriptor = Buffer.concat([
                u32(0x08074B50),
                u32(crc),
                u32(file.size),
                u32(file.size)
            ]);

            await write(res, descriptor);
            offset += file.size + descriptor.length;

            central.push(Buffer.concat([
                u32(0x02014B50),
                u16(20),
                u16(20),
                u16(0x0008),
                u16(0),
                u16(date.time),
                u16(date.date),
                u32(crc),
                u32(file.size),
                u32(file.size),
                u16(name.length),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(0),
                u32(start),
                name
            ]));
        }

        const centralSize = central.reduce((sum, item) => sum + item.length, 0);

        for (const item of central) {
            await write(res, item);
        }

        await write(res, Buffer.concat([
            u32(0x06054B50),
            u16(0),
            u16(0),
            u16(central.length),
            u16(central.length),
            u32(centralSize),
            u32(offset),
            u16(0)
        ]));
    }

    return send;
};
