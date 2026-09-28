const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const STORAGE = path.join(BASE, 'storage');
const HTML_PATH = path.join(BASE, 'web', 'index.html');
const URL_FILE = path.join(BASE, 'nyXflash.url');
const PORT_FILE = path.join(BASE, 'nyXflash.port');
const TOKEN_FILE = path.join(BASE, 'nyXflash.token');
const PORT = Number(process.env.NYXFLASH_PORT || 0);
const VERSION = '3.1.0';
let currentPort = 0;
const TOKEN = crypto.randomBytes(24).toString('hex');
const transfers = new Map();
const startedAt = Date.now();
let closing = false;
let currentBind = '';
const LISTEN_HOST = '0.0.0.0';
let server = null;

const MIME = {
    '.7z': 'application/x-7z-compressed', '.avi': 'video/x-msvideo', '.bmp': 'image/bmp',
    '.csv': 'text/csv; charset=utf-8', '.gif': 'image/gif', '.gz': 'application/gzip',
    '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.m4a': 'audio/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.tar': 'application/x-tar', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav',
    '.webm': 'video/webm', '.webp': 'image/webp', '.zip': 'application/zip'
};

function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

function privateIPv4(address) {
    const p = address.split('.').map(Number);
    if (p.length !== 4 || p.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return false;
    return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function getWifiAddress() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const [name, items] of Object.entries(interfaces)) {
        const lower = name.toLowerCase();
        const wifi = lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wireless') || lower.includes('wlan');
        const virtual = lower.includes('virtual') || lower.includes('vmware') || lower.includes('hyper-v') || lower.includes('vethernet') || lower.includes('vpn') || lower.includes('loopback');
        for (const item of items || []) {
            if (item.family !== 'IPv4' || item.internal || !privateIPv4(item.address)) continue;
            let score = wifi ? 100 : 50;
            if (virtual) score -= 200;
            candidates.push({ address: item.address, score, name });
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
    return candidates[0]?.address || null;
}

function forceBindAddress() {
    const v = String(process.env.NYXFLASH_BIND || '').trim();
    return v || getWifiAddress();
}

function safeRelative(relativePath) {
    const decoded = String(relativePath || '').replace(/\\/g, '/');
    if (!decoded || decoded.includes('\0') || decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) return null;
    const parts = decoded.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) return null;
    return parts.join('/');
}

function candidatePath(relativePath) {
    const clean = safeRelative(relativePath);
    if (!clean) return null;
    return path.resolve(STORAGE, ...clean.split('/'));
}

function withinStorage(candidate) {
    const rootWithSep = STORAGE.endsWith(path.sep) ? STORAGE : STORAGE + path.sep;
    return candidate === STORAGE || candidate.startsWith(rootWithSep);
}

async function secureExisting(relativePath) {
    const candidate = candidatePath(relativePath);
    if (!candidate || !withinStorage(candidate)) return null;
    let real;
    try { real = await fs.promises.realpath(candidate); } catch (_) { return null; }
    if (!withinStorage(real)) return null;
    return real;
}

async function secureUploadTarget(relativePath) {
    const clean = safeRelative(relativePath);
    if (!clean) return null;
    const target = candidatePath(clean);
    if (!target || !withinStorage(target)) return null;
    let parent = path.dirname(target);
    while (parent !== STORAGE && !fs.existsSync(parent)) {
        const next = path.dirname(parent);
        if (next === parent) return null;
        parent = next;
    }
    let parentReal;
    try { parentReal = await fs.promises.realpath(parent); } catch (_) { return null; }
    if (!withinStorage(parentReal)) return null;
    if (fs.existsSync(target)) {
        let stat;
        try { stat = await fs.promises.lstat(target); } catch (_) { return null; }
        if (stat.isSymbolicLink()) return null;
    }
    return target;
}

function contentDisposition(name) {
    const fallback = name.replace(/[\r\n"\\]/g, '_');
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function id() { return crypto.randomBytes(12).toString('hex'); }

function makeTransfer(kind, name, total) {
    const item = { id: id(), kind, name, total: Number.isFinite(total) ? total : 0, bytes: 0, done: false, error: '', startedAt: Date.now(), updatedAt: Date.now() };
    transfers.set(item.id, item);
    return item;
}

function cleanTransfers() {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [key, item] of transfers) if (item.done && item.updatedAt < cutoff) transfers.delete(key);
}

function speed(item) {
    return item.bytes / Math.max(0.001, (Date.now() - item.startedAt) / 1000);
}

async function uniqueTarget(requested) {
    const ext = path.extname(requested);
    const base = ext ? path.basename(requested, ext) : path.basename(requested);
    const parent = path.dirname(requested);
    let n = 0;
    let candidate = requested;
    while (true) {
        try {
            const h = await fs.promises.open(candidate, 'wx');
            await h.close();
            await fs.promises.unlink(candidate);
            return candidate;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            n++;
            candidate = path.join(parent, `${base} (${n})${ext}`);
        }
    }
}

async function writeReadyFiles() {
    const url = `http://${currentBind}:${currentPort}/?t=${TOKEN}`;
    await fs.promises.writeFile(PORT_FILE, String(currentPort), 'utf8');
    await fs.promises.writeFile(URL_FILE, url, 'utf8');
    await fs.promises.writeFile(TOKEN_FILE, TOKEN, 'utf8');
}

function clearReadyFiles() {
    for (const file of [URL_FILE, PORT_FILE, TOKEN_FILE]) {
        try { fs.unlinkSync(file); } catch (_) {}
    }
}

async function copyFileStream(source, destination) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
        const output = fs.createWriteStream(destination, { flags: 'wx', highWaterMark: 1024 * 1024 });
        input.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(output);
    });
}

async function copyIntoStorage(source) {
    const absolute = path.resolve(source);
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('links_not_supported');
    const baseName = path.basename(absolute) || 'arquivo';
    let destination = path.join(STORAGE, baseName);
    if (stat.isFile()) {
        destination = await uniqueTarget(destination);
        await copyFileStream(absolute, destination);
        return path.relative(STORAGE, destination).replace(/\\/g, '/');
    }
    if (!stat.isDirectory()) throw new Error('unsupported_target');
    let folder = destination;
    let n = 0;
    while (true) {
        try { await fs.promises.mkdir(folder, { recursive: false }); break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; n++; folder = path.join(STORAGE, `${baseName} (${n})`); }
    }
    async function walk(srcDir, dstDir) {
        const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const src = path.join(srcDir, entry.name);
            const dst = path.join(dstDir, entry.name);
            if (entry.isDirectory()) {
                await fs.promises.mkdir(dst, { recursive: false });
                await walk(src, dst);
            } else if (entry.isFile()) {
                await copyFileStream(src, dst);
            }
        }
    }
    await walk(absolute, folder);
    return path.relative(STORAGE, folder).replace(/\\/g, '/');
}

async function importArguments() {
    await fs.promises.mkdir(STORAGE, { recursive: true });
    const imports = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--import' && argv[i + 1]) { imports.push(argv[++i]); continue; }
    }
    const imported = [];
    for (const item of imports) {
        try { imported.push(await copyIntoStorage(item)); }
        catch (_) {}
    }
    return imported;
}

async function listDirectory(relativePath) {
    const real = relativePath ? await secureExisting(relativePath) : STORAGE;
    if (!real) throw new Error('invalid_path');
    const stat = await fs.promises.stat(real);
    if (!stat.isDirectory()) throw new Error('not_directory');
    const raw = await fs.promises.readdir(real, { withFileTypes: true });
    const result = [];
    for (const entry of raw) {
        if (entry.isSymbolicLink()) continue;
        const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const full = path.join(real, entry.name);
        let childStat = null;
        try { childStat = await fs.promises.stat(full); } catch (_) {}
        result.push({
            name: entry.name,
            directory: entry.isDirectory(),
            size: childStat && childStat.isFile() ? childStat.size : null,
            modified: childStat ? childStat.mtimeMs : null,
            path: childRel
        });
    }
    result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return result;
}

async function countStorage() {
    let files = 0, folders = 0;
    async function walk(dir) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { folders++; await walk(path.join(dir, entry.name)); }
            else if (entry.isFile()) files++;
        }
    }
    await walk(STORAGE);
    return { files, folders };
}

function parseJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        req.on('data', chunk => {
            length += chunk.length;
            if (length > 1024 * 1024) { req.destroy(); reject(new Error('payload_too_large')); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (_) { reject(new Error('invalid_json')); }
        });
        req.on('error', reject);
    });
}

function openDownload(req, res, filePath, name, total, transfer) {
    let start = 0;
    let end = total > 0 ? total - 1 : 0;
    let status = 200;
    if (req.headers.range && total > 0) {
        const m = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range);
        if (m) {
            const rs = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2] || 0));
            const re = m[2] ? Number(m[2]) : total - 1;
            if (Number.isInteger(rs) && Number.isInteger(re) && rs >= 0 && rs <= re && rs < total) {
                start = rs; end = Math.min(re, total - 1); status = 206;
            }
        }
    }
    const length = total === 0 ? 0 : end - start + 1;
    transfer.total = length;
    transfer.bytes = 0;
    transfer.startedAt = Date.now();
    transfer.updatedAt = Date.now();
    const stream = total === 0 ? null : fs.createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
    if (stream) {
        stream.on('data', chunk => { transfer.bytes += chunk.length; transfer.updatedAt = Date.now(); });
        stream.on('end', () => { transfer.done = true; transfer.updatedAt = Date.now(); });
        stream.on('error', error => { transfer.error = error.message; transfer.done = true; transfer.updatedAt = Date.now(); if (!res.headersSent) res.writeHead(500); res.end(); });
        res.on('close', () => { if (!transfer.done) { transfer.error = 'connection_closed'; transfer.done = true; } transfer.updatedAt = Date.now(); stream.destroy(); });
    }
    const headers = {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Disposition': contentDisposition(name),
        'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Length': length
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, headers);
    if (!stream) { transfer.done = true; transfer.updatedAt = Date.now(); return res.end(); }
    stream.pipe(res);
}

async function handleDownload(req, res, url) {
    if (url.searchParams.get('t') !== TOKEN) return text(res, 403, 'forbidden');
    const rel = url.searchParams.get('path') || '';
    const file = await secureExisting(rel);
    if (!file) return text(res, 404, 'not_found');
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return text(res, 400, 'use_folder_endpoint');
    let transfer = transfers.get(url.searchParams.get('id'));
    if (!transfer) transfer = makeTransfer('download', path.basename(file), stat.size);
    if (transfer.kind !== 'download' || transfer.name !== path.basename(file)) return text(res, 404, 'transfer_not_found');
    openDownload(req, res, file, path.basename(file), stat.size, transfer);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crcUpdate(crc, chunk) {
    let c = crc ^ 0xFFFFFFFF;
    for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8);
    return c ^ 0xFFFFFFFF;
}

function u16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n & 0xFFFF); return b; }
function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0); return b; }
async function writeRes(res, buffer) {
    if (res.write(buffer)) return;
    await new Promise(resolve => res.once('drain', resolve));
}

async function collectFiles(dir, prefix, result) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collectFiles(abs, rel, result);
        else if (entry.isFile()) {
            const stat = await fs.promises.stat(abs);
            if (stat.size > 0xFFFFFFFF) throw new Error('file_too_large_for_zip');
            result.push({ abs, rel, size: stat.size, mtime: stat.mtime });
        }
    }
}

function dosTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

async function streamFolderZip(res, dir, zipName, transfer) {
    const files = [];
    await collectFiles(dir, path.basename(dir), files);
    let offset = 0;
    const central = [];
    for (const file of files) {
        const name = Buffer.from(file.rel.replace(/\\/g, '/'), 'utf8');
        const dt = dosTime(file.mtime);
        const localOffset = offset;
        const header = Buffer.concat([u32(0x04034B50), u16(20), u16(0x0008), u16(0), u16(dt.time), u16(dt.date), u32(0), u32(file.size), u32(file.size), u16(name.length), u16(0), name]);
        await writeRes(res, header); offset += header.length;
        const input = fs.createReadStream(file.abs, { highWaterMark: 1024 * 1024 });
        let crc = 0;
        await new Promise((resolve, reject) => {
            input.on('data', async chunk => {
                input.pause();
                try { crc = crcUpdate(crc, chunk); transfer.bytes += chunk.length; transfer.updatedAt = Date.now(); await writeRes(res, chunk); input.resume(); }
                catch (e) { reject(e); }
            });
            input.on('end', resolve);
            input.on('error', reject);
        });
        const descriptor = Buffer.concat([u32(0x08074B50), u32(crc), u32(file.size), u32(file.size)]);
        await writeRes(res, descriptor); offset += file.size + descriptor.length;
        central.push(Buffer.concat([u32(0x02014B50), u16(20), u16(20), u16(0x0008), u16(0), u16(dt.time), u16(dt.date), u32(crc), u32(file.size), u32(file.size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name]));
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    for (const item of central) await writeRes(res, item);
    const eocd = Buffer.concat([u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralSize), u32(offset), u16(0)]);
    await writeRes(res, eocd);
}

async function handleFolderDownload(req, res, url) {
    if (url.searchParams.get('t') !== TOKEN) return text(res, 403, 'forbidden');
    const rel = url.searchParams.get('path') || '';
    const dir = await secureExisting(rel);
    if (!dir) return text(res, 404, 'not_found');
    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) return text(res, 400, 'not_directory');
    let transfer = transfers.get(url.searchParams.get('id'));
    if (!transfer) transfer = makeTransfer('download', `${path.basename(dir)}.zip`, total);
    if (transfer.kind !== 'download' || transfer.name !== `${path.basename(dir)}.zip`) return text(res, 404, 'transfer_not_found');
    const files = [];
    await collectFiles(dir, path.basename(dir), files);
    transfer.total = files.reduce((n, item) => n + item.size, 0);
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(`${path.basename(dir)}.zip`),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Transfer-Encoding': 'chunked'
    });
    try { await streamFolderZip(res, dir, `${path.basename(dir)}.zip`, transfer); transfer.done = true; transfer.updatedAt = Date.now(); res.end(); }
    catch (e) { transfer.error = e.message; transfer.done = true; transfer.updatedAt = Date.now(); try { res.end(); } catch (_) {} }
}

async function handleUpload(req, res, url) {
    if (url.searchParams.get('t') !== TOKEN) return text(res, 403, 'forbidden');
    const requested = safeRelative(url.searchParams.get('path') || '');
    if (!requested) return text(res, 400, 'invalid_path');
    const rawTarget = await secureUploadTarget(requested);
    if (!rawTarget) return text(res, 400, 'invalid_path');
    await fs.promises.mkdir(path.dirname(rawTarget), { recursive: true });
    let target = rawTarget;
    try { target = await uniqueTarget(target); } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    const total = Number(req.headers['content-length'] || 0);
    const transfer = makeTransfer('upload', path.basename(target), Number.isFinite(total) ? total : 0);
    const out = fs.createWriteStream(target, { flags: 'wx', highWaterMark: 1024 * 1024 });
    let failed = false;
    req.on('data', chunk => { transfer.bytes += chunk.length; transfer.updatedAt = Date.now(); });
    req.on('aborted', () => { failed = true; transfer.error = 'request_aborted'; out.destroy(); try { fs.unlinkSync(target); } catch (_) {} });
    out.on('error', error => {
        failed = true; transfer.error = error.message; transfer.done = true; transfer.updatedAt = Date.now();
        try { fs.unlinkSync(target); } catch (_) {}
        if (!res.headersSent) json(res, 500, { ok: false, error: transfer.error });
    });
    out.on('finish', () => {
        if (failed) return;
        transfer.done = true; transfer.updatedAt = Date.now();
        json(res, 200, { ok: true, transfer: transfer.id, path: path.relative(STORAGE, target).replace(/\\/g, '/') });
    });
    req.pipe(out);
}

async function removePath(relativePath) {
    const real = await secureExisting(relativePath);
    if (!real || real === STORAGE) throw new Error('invalid_path');
    await fs.promises.rm(real, { recursive: true, force: false });
}

async function renamePath(relativePath, newName) {
    const clean = safeRelative(relativePath);
    if (!clean || !newName || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') throw new Error('invalid_name');
    const oldReal = await secureExisting(clean);
    if (!oldReal || oldReal === STORAGE) throw new Error('invalid_path');
    const target = path.resolve(path.dirname(oldReal), newName);
    if (!withinStorage(target)) throw new Error('invalid_name');
    if (fs.existsSync(target)) throw new Error('destination_exists');
    await fs.promises.rename(oldReal, target);
}

async function makeFolder(relativePath) {
    const clean = safeRelative(relativePath);
    if (!clean) throw new Error('invalid_path');
    const target = candidatePath(clean);
    if (!target || !withinStorage(target)) throw new Error('invalid_path');
    await fs.promises.mkdir(target, { recursive: false });
}

function authorized(url) { return url.searchParams.get('t') === TOKEN; }

async function requestHandler(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host || currentBind || '127.0.0.1'}`);
        const pathname = url.pathname;
        if ((pathname === '/api/info' || pathname === '/api/tree' || pathname === '/api/progress' || pathname === '/api/shutdown' || pathname === '/api/delete' || pathname === '/api/rename' || pathname === '/api/mkdir' || pathname === '/api/download-start' || pathname === '/download' || pathname === '/download-folder' || pathname === '/upload' || pathname === '/') && !authorized(url) && pathname !== '/') return text(res, 403, 'forbidden');
        if (req.method === 'GET' && pathname === '/') {
            if (!authorized(url)) { res.writeHead(302, { Location: `/?t=${TOKEN}`, 'Cache-Control': 'no-store' }); return res.end(); }
            const body = await fs.promises.readFile(HTML_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(body);
        }
        if (req.method === 'GET' && pathname === '/api/info') {
            const stats = await countStorage();
            return json(res, 200, { ok: true, version: VERSION, token: TOKEN, name: 'nyXflash Drive', storageName: path.basename(STORAGE), url: `http://${currentBind}:${currentPort}/?t=${TOKEN}`, lanAddress: currentBind, listenHost: LISTEN_HOST, port: currentPort, wifiRequired: true, files: stats.files, folders: stats.folders, startedAt });
        }
        if (req.method === 'GET' && pathname === '/api/tree') {
            const relative = url.searchParams.get('path') || '';
            const entries = await listDirectory(relative);
            return json(res, 200, { ok: true, path: relative, entries });
        }
        if (req.method === 'GET' && pathname === '/api/download-start') {
            const relative = url.searchParams.get('path') || '';
            const file = await secureExisting(relative);
            if (!file) return text(res, 404, 'not_found');
            const stat = await fs.promises.stat(file);
            if (!stat.isFile()) return text(res, 400, 'not_file');
            const transfer = makeTransfer('download', path.basename(file), stat.size);
            return json(res, 200, { ok: true, id: transfer.id, name: transfer.name, size: transfer.total, url: `/download?t=${TOKEN}&id=${transfer.id}&path=${encodeURIComponent(relative)}` });
        }
        if (req.method === 'GET' && pathname === '/api/folder-download-start') {
            const relative = url.searchParams.get('path') || '';
            const dir = await secureExisting(relative);
            if (!dir) return text(res, 404, 'not_found');
            const stat = await fs.promises.stat(dir);
            if (!stat.isDirectory()) return text(res, 400, 'not_directory');
            const files = [];
            await collectFiles(dir, path.basename(dir), files);
            const total = files.reduce((n, item) => n + item.size, 0);
            const transfer = makeTransfer('download', `${path.basename(dir)}.zip`, total);
            return json(res, 200, { ok: true, id: transfer.id, name: transfer.name, size: total, url: `/download-folder?t=${TOKEN}&id=${transfer.id}&path=${encodeURIComponent(relative)}` });
        }
        if (req.method === 'GET' && pathname === '/download') return handleDownload(req, res, url);
        if (req.method === 'GET' && pathname === '/download-folder') return handleFolderDownload(req, res, url);
        if (req.method === 'GET' && pathname === '/api/progress') {
            const item = transfers.get(url.searchParams.get('id'));
            if (!item) return text(res, 404, 'transfer_not_found');
            return json(res, 200, { ok: true, id: item.id, kind: item.kind, name: item.name, bytes: item.bytes, total: item.total, done: item.done, error: item.error, speed: speed(item) });
        }
        if (req.method === 'PUT' && pathname === '/upload') return handleUpload(req, res, url);
        if (req.method === 'POST' && pathname === '/api/delete') {
            const body = await parseJson(req);
            await removePath(String(body.path || ''));
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/api/rename') {
            const body = await parseJson(req);
            await renamePath(String(body.path || ''), String(body.name || ''));
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/api/mkdir') {
            const body = await parseJson(req);
            await makeFolder(String(body.path || ''));
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/api/shutdown') {
            json(res, 200, { ok: true });
            setTimeout(() => shutdown(0), 50);
            return;
        }
        if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        return text(res, 404, 'not_found');
    } catch (error) {
        if (!res.headersSent) return json(res, 400, { ok: false, error: error && error.message ? error.message : 'server_error' });
        res.end();
    }
}

function buildServer() {
    const instance = http.createServer(requestHandler);
    instance.on('connection', socket => { socket.setNoDelay(true); socket.setKeepAlive(true, 5000); });
    return instance;
}

async function listen() {
    currentBind = forceBindAddress();
    if (!currentBind) throw new Error('wifi_not_connected');
    server = buildServer();
    await new Promise((resolve, reject) => {
        const onError = e => { server.off('listening', onListen); reject(e); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen({ port: PORT, host: LISTEN_HOST, exclusive: false });
    });
    currentPort = server.address().port;
    await writeReadyFiles();
}

async function shutdown(code) {
    if (closing) return;
    closing = true;
    clearReadyFiles();
    if (server) {
        try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) {}
        try { await new Promise(resolve => server.close(() => resolve())); } catch (_) {}
    }
    process.exit(code);
}

async function watchNetwork() {
    const next = forceBindAddress();
    if (!next) {
        await shutdown(0);
        return;
    }
    if (next !== currentBind) {
        clearReadyFiles();
        try { if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) {}
        try { if (server) await new Promise(resolve => server.close(() => resolve())); } catch (_) {}
        if (closing) return;
        currentBind = next;
        try {
            server = buildServer();
            await new Promise((resolve, reject) => {
                const onError = e => { server.off('listening', onListen); reject(e); };
                const onListen = () => { server.off('error', onError); resolve(); };
                server.once('error', onError); server.once('listening', onListen);
                server.listen({ port: PORT, host: LISTEN_HOST, exclusive: false });
            });
            currentPort = server.address().port;
            await writeReadyFiles();
        } catch (_) { await shutdown(1); }
    }
}

(async () => {
    try {
        await importArguments();
        await listen();
        setInterval(cleanTransfers, 5 * 60 * 1000).unref();
        setInterval(() => { watchNetwork().catch(() => shutdown(1)); }, 1500).unref();
        process.on('SIGINT', () => shutdown(0));
        process.on('SIGTERM', () => shutdown(0));
        process.on('uncaughtException', () => shutdown(1));
        process.on('unhandledRejection', () => shutdown(1));
    } catch (error) {
        clearReadyFiles();
        process.exit(1);
    }
})();
