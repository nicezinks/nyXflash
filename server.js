const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const config = require('./config');
const createStorage = require('./storage');
const createZip = require('./zip');

const files = createStorage(config.storage, config);
const sendFolderZip = createZip(config.storage, config);

let server;
let port = config.port;
let shuttingDown = false;
let connections = 0;
let uploads = 0;
let uploadBytes = 0;
let transfers = 0;

const connectionsByIp = new Map();
const requestsByIp = new Map();
const changesByIp = new Map();
const uploadsByIp = new Map();
const transfersByIp = new Map();
const batches = new Map();
const sessions = new Map();
const loginAttempts = new Map();
let accessPin = '';

const knownErrors = new Set([
    'caminho_invalido',
    'caminho_nao_encontrado',
    'arquivo_nao_encontrado',
    'pasta_nao_encontrada',
    'nao_e_pasta',
    'nao_e_arquivo',
    'use_download_folder',
    'arquivo_ja_existe',
    'nome_ja_existe',
    'nome_invalido',
    'pasta_invalida',
    'atalho_nao_suportado',
    'json_invalido',
    'json_muito_grande',
    'arquivo_muito_grande',
    'max_arquivos',
    'muitos_uploads',
    'muitos_pedidos',
    'rede_local_apenas',
    'host_invalido',
    'cliente_invalido',
    'origem_invalida',
    'muitas_conexoes',
    'muitos_downloads',
    'muitos_arquivos',
    'pasta_grande_demais',
    'arquivo_muito_grande_para_zip',
    'zip_grande_demais',
    'nome_grande_demais',
    'metodo_nao_permitido',
    'sem_espaco',
    'arquivo_ausente_durante_envio'
]);

function responseHeaders(extra = {}) {
    return {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-Permitted-Cross-Domain-Policies': 'none',
        ...extra
    };
}

function json(res, status, data, extra = {}) {
    if (res.headersSent || res.destroyed) return false;

    const body = JSON.stringify(data);
    res.writeHead(status, responseHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...extra
    }));
    res.end(body);
    return true;
}

function text(res, status, message, extra = {}) {
    if (res.headersSent || res.destroyed) return false;

    const body = String(message);
    res.writeHead(status, responseHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...extra
    }));
    res.end(body);
    return true;
}

function errorCode(error) {
    return error && typeof error.message === 'string' ? error.message : '';
}

function fail(res, error, status = 400) {
    const code = errorCode(error);

    if (code === 'muitos_pedidos') {
        return json(res, 429, {
            ok: false,
            error: code,
            message: 'Muitas requisicoes. Aguarde um pouco.'
        }, {
            'Retry-After': '60'
        });
    }

    if (code === 'autenticacao_necessaria') {
        return json(res, 401, { ok: false, error: code, message: 'Autenticacao necessaria.' }, { 'WWW-Authenticate': 'Session' });
    }

    if (code === 'pin_invalido') {
        return json(res, 401, { ok: false, error: code, message: 'PIN invalido.' });
    }

    if (code === 'muitas_tentativas') {
        return json(res, 429, { ok: false, error: code, message: 'Muitas tentativas. Aguarde um pouco.' }, { 'Retry-After': String(Math.ceil(config.loginLockMs / 1000)) });
    }

    if (code === 'muitos_uploads') {
        return json(res, 429, {
            ok: false,
            error: code,
            message: 'Muitos uploads simultaneos. Aguarde um pouco.'
        });
    }

    if (code === 'muitos_downloads') {
        return json(res, 429, {
            ok: false,
            error: code,
            message: 'Muitos downloads simultaneos. Aguarde um pouco.'
        });
    }

    if (code === 'muitas_conexoes') {
        return json(res, 429, {
            ok: false,
            error: code,
            message: 'Muitas conexoes ativas.'
        });
    }

    if (code === 'rede_local_apenas') {
        return json(res, 403, {
            ok: false,
            error: code,
            message: 'Acesso permitido somente pela rede local.'
        });
    }

    if (code === 'host_invalido') {
        return json(res, 400, {
            ok: false,
            error: code,
            message: 'Endereco de acesso invalido.'
        });
    }

    if (code === 'cliente_invalido') {
        return json(res, 403, {
            ok: false,
            error: code,
            message: 'Operacao recusada.'
        });
    }

    if (code === 'origem_invalida') {
        return json(res, 403, {
            ok: false,
            error: code,
            message: 'Origem recusada.'
        });
    }

    if (code === 'sem_espaco') {
        return json(res, 507, {
            ok: false,
            error: code,
            message: 'Espaco livre insuficiente.'
        });
    }

    if (knownErrors.has(code)) {
        return json(res, status, { ok: false, error: code });
    }

    return json(res, 500, { ok: false, error: 'erro_interno' });
}

function toIpv4(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 4) return null;

    let number = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        number = number * 256 + octet;
    }

    return number >>> 0;
}

function isPrivateIp(value) {
    const ip = toIpv4(value);
    if (ip === null) return false;

    const a = ip >>> 24;
    const b = (ip >>> 16) & 255;

    return a === 10 ||
        a === 127 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31);
}

function normalizeIp(value) {
    const ip = String(value || '').replace(/^::ffff:/i, '');
    return ip === '::1' ? '127.0.0.1' : ip;
}

function localNetworks() {
    const networks = [];
    const interfaces = os.networkInterfaces();

    for (const [name, list] of Object.entries(interfaces)) {
        for (const item of list || []) {
            if (item.family !== 'IPv4' || item.internal || !isPrivateIp(item.address)) {
                continue;
            }

            const address = toIpv4(item.address);
            const mask = toIpv4(item.netmask);
            if (address === null || mask === null) continue;

            networks.push({
                name,
                address,
                mask,
                text: item.address
            });
        }
    }

    return networks;
}

function localIps() {
    return [...new Set(localNetworks().map(item => item.text))];
}

function isLocalClient(address) {
    const ip = normalizeIp(address);
    if (ip === '127.0.0.1') return true;

    const remote = toIpv4(ip);
    if (remote === null) return false;

    return localNetworks().some(network => {
        return (remote & network.mask) === (network.address & network.mask);
    });
}

function validHost(req) {
    const value = String(req.headers.host || '').trim();
    if (!value || value.length > 255 || value.includes('@') || value.startsWith('[')) {
        return false;
    }

    const firstColon = value.indexOf(':');
    const lastColon = value.lastIndexOf(':');
    let host = value;
    let hostPort = String(port);

    if (firstColon !== -1) {
        if (firstColon !== lastColon) return false;
        host = value.slice(0, firstColon);
        hostPort = value.slice(firstColon + 1);
    }

    if (!host || !/^\d{1,5}$/.test(hostPort) || Number(hostPort) !== port) {
        return false;
    }

    const allowed = new Set(['localhost', '127.0.0.1', ...localIps()]);
    return allowed.has(host.toLowerCase());
}

function limit(map, key, max, windowMs, code) {
    const now = Date.now();
    let entry = map.get(key);

    if (!entry || now - entry.start >= windowMs) {
        entry = { start: now, count: 0 };
        map.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > max) throw new Error(code);
}

function cookieValue(req, name) {
    const header = String(req.headers.cookie || '');
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return '';
}

function requireAuth(req) {
    const token = cookieValue(req, 'nyxflash_session');
    const session = sessions.get(token);
    const ip = normalizeIp(req.socket.remoteAddress);

    if (!session || session.ip !== ip || session.expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        throw new Error('autenticacao_necessaria');
    }

    session.expiresAt = Date.now() + config.sessionTtl;
    return session;
}

function loginAllowed(ip) {
    const now = Date.now();
    let entry = loginAttempts.get(ip);

    if (!entry || now - entry.start >= 60_000) {
        entry = { start: now, count: 0, lockedUntil: 0 };
        loginAttempts.set(ip, entry);
    }

    return entry.lockedUntil <= now && entry.count < config.loginAttemptsPerMinute;
}

function recordLoginFailure(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { start: now, count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= config.loginAttemptsPerMinute) entry.lockedUntil = now + config.loginLockMs;
    loginAttempts.set(ip, entry);
}

function authenticate(req, res, pin, ip) {
    if (!loginAllowed(ip)) throw new Error('muitas_tentativas');
    if (String(pin || '') !== accessPin) {
        recordLoginFailure(ip);
        throw new Error('pin_invalido');
    }

    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { ip, expiresAt: Date.now() + config.sessionTtl });
    res.setHeader('Set-Cookie', `nyxflash_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtl / 1000)}`);
}

function checkMutation(req) {
    requireAuth(req);

    const origin = String(req.headers.origin || '');
    if (!origin) return;

    let parsed;
    try {
        parsed = new URL(origin);
    } catch (_) {
        throw new Error('origem_invalida');
    }

    if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
        throw new Error('origem_invalida');
    }
}

function onConnection(socket) {
    const ip = normalizeIp(socket.remoteAddress);
    connections += 1;

    const ipCount = (connectionsByIp.get(ip) || 0) + 1;
    connectionsByIp.set(ip, ipCount);

    socket.once('close', () => {
        connections = Math.max(0, connections - 1);
        const count = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);

        if (count) connectionsByIp.set(ip, count);
        else connectionsByIp.delete(ip);
    });

    if (!isLocalClient(ip) || connections > config.maxConnections || ipCount > config.maxConnectionsPerIp) {
        socket.destroy();
    }
}

function startTransfer(ip) {
    if (transfers >= config.maxTransfers || (transfersByIp.get(ip) || 0) >= config.maxTransfersPerIp) {
        throw new Error('muitos_downloads');
    }

    transfers += 1;
    transfersByIp.set(ip, (transfersByIp.get(ip) || 0) + 1);

    return () => {
        transfers = Math.max(0, transfers - 1);
        const count = Math.max(0, (transfersByIp.get(ip) || 1) - 1);

        if (count) transfersByIp.set(ip, count);
        else transfersByIp.delete(ip);
    };
}

function startUpload(size, ip) {
    if (
        uploads >= config.maxUploads ||
        (uploadsByIp.get(ip) || 0) >= config.maxUploadsPerIp ||
        uploadBytes + size > config.maxActiveUploadBytes
    ) {
        throw new Error('muitos_uploads');
    }

    uploads += 1;
    uploadBytes += size;
    uploadsByIp.set(ip, (uploadsByIp.get(ip) || 0) + 1);
    let reserved = size;

    return {
        add(bytes) {
            if (bytes <= 0) return;
            if (uploadBytes + bytes > config.maxActiveUploadBytes) {
                throw new Error('muitos_uploads');
            }
            uploadBytes += bytes;
            reserved += bytes;
        },
        release() {
            uploads = Math.max(0, uploads - 1);
            uploadBytes = Math.max(0, uploadBytes - reserved);

            const count = Math.max(0, (uploadsByIp.get(ip) || 1) - 1);
            if (count) uploadsByIp.set(ip, count);
            else uploadsByIp.delete(ip);
        }
    };
}

function useBatch(value, ip) {
    const id = String(value || '').trim();
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id)) throw new Error('cliente_invalido');

    const now = Date.now();
    let batch = batches.get(id);

    if (!batch || now - batch.time >= config.batchTtl || batch.ip !== ip) {
        batch = { time: now, count: 0, ip };
        batches.set(id, batch);
    }

    if (config.maxFiles > 0 && batch.count >= config.maxFiles) throw new Error('max_arquivos');
    batch.count += 1;
}

function downloadName(name) {
    const safe = String(name || 'arquivo').replace(/[\r\n"\\]/g, '_');
    return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function readJson(req) {
    let size = 0;
    const chunks = [];

    return new Promise((resolve, reject) => {
        let finished = false;

        function finish(error, value) {
            if (finished) return;
            finished = true;
            error ? reject(error) : resolve(value);
        }

        req.on('data', chunk => {
            size += chunk.length;
            if (size > config.maxJsonSize) {
                req.destroy();
                finish(new Error('json_muito_grande'));
                return;
            }
            chunks.push(chunk);
        });

        req.on('aborted', () => finish(new Error('cliente_invalido')));
        req.on('error', finish);
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8') || '{}';
                finish(null, JSON.parse(body));
            } catch (_) {
                finish(new Error('json_invalido'));
            }
        });
    });
}

async function upload(req, res, url, ip) {
    checkMutation(req);
    limit(changesByIp, ip, config.maxChangesPerMinute, 60_000, 'muitos_pedidos');

    const relative = url.searchParams.get('path') || '';
    const batchId = req.headers['x-nyxflash-batch'] || '';
    const lengthHeader = String(req.headers['content-length'] || '');
    const hasLength = /^\d+$/.test(lengthHeader);
    const length = hasLength ? Number(lengthHeader) : 0;

    if (hasLength && !Number.isSafeInteger(length)) {
        return text(res, 413, 'arquivo_muito_grande');
    }

    if (config.maxFileSize > 0 && hasLength && length > config.maxFileSize) {
        return text(res, 413, 'arquivo_muito_grande');
    }

    const target = await files.uploadTarget(relative);
    if (!target) return text(res, 400, 'caminho_invalido');

    useBatch(batchId, ip);
    const transfer = startUpload(length, ip);
    let tempFile = null;

    try {
        if (hasLength && !(await files.enoughSpace(length))) throw new Error('sem_espaco');

        await fs.promises.mkdir(path.join(config.storage, '.tmp'), { recursive: true });

        tempFile = path.join(
            config.storage,
            '.tmp',
            `${crypto.randomBytes(20).toString('hex')}.part`
        );

        const output = fs.createWriteStream(tempFile, { flags: 'wx' });
        let received = 0;

        try {
            for await (const chunk of req) {
                received += chunk.length;

                if (config.maxFileSize > 0 && received > config.maxFileSize) {
                    throw new Error('arquivo_muito_grande');
                }
                if (hasLength && received > length) {
                    throw new Error('arquivo_muito_grande');
                }
                if (!hasLength && !(await files.enoughSpace(chunk.length))) {
                    throw new Error('sem_espaco');
                }
                if (!hasLength) transfer.add(chunk.length);

                if (!output.write(chunk)) {
                    await new Promise((resolve, reject) => {
                        const done = () => {
                            output.off('error', fail);
                            resolve();
                        };
                        const fail = error => {
                            output.off('drain', done);
                            reject(error);
                        };
                        output.once('drain', done);
                        output.once('error', fail);
                    });
                }
            }

            if (hasLength && received !== length) {
                throw new Error('arquivo_ausente_durante_envio');
            }

            await new Promise((resolve, reject) => {
                output.once('error', reject);
                output.end(resolve);
            });
        } catch (error) {
            output.destroy();
            throw error;
        }

        const parent = path.dirname(target);
        const parentReal = path.resolve(await fs.promises.realpath(parent));
        const storageRoot = path.resolve(config.storage);
        if (parentReal !== storageRoot && !parentReal.startsWith(storageRoot + path.sep)) {
            throw new Error('caminho_invalido');
        }

        try {
            await fs.promises.lstat(target);
            throw new Error('arquivo_ja_existe');
        } catch (error) {
            if (error.message === 'arquivo_ja_existe') throw error;
            if (error.code !== 'ENOENT') throw error;
        }

        await fs.promises.rename(tempFile, target);
        tempFile = null;

        return json(res, 200, {
            ok: true,
            path: relative,
            size: received
        });
    } catch (error) {
        if (tempFile) await fs.promises.rm(tempFile, { force: true }).catch(() => {});
        return fail(res, error);
    } finally {
        transfer.release();
    }
}

async function downloadFile(req, res, url, ip) {
    const release = startTransfer(ip);
    res.once('close', release);

    const relative = url.searchParams.get('path') || '';
    const file = await files.existingPath(relative);

    if (!file) return text(res, 404, 'arquivo_nao_encontrado');

    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return text(res, 400, 'use_download_folder');

    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = String(req.headers.range || '');

    if (range && stat.size > 0) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return text(res, 416, 'range_invalido');

        const requestedStart = match[1]
            ? Number(match[1])
            : Math.max(0, stat.size - Number(match[2] || 0));
        const requestedEnd = match[2]
            ? Number(match[2])
            : stat.size - 1;

        if (
            !Number.isSafeInteger(requestedStart) ||
            !Number.isSafeInteger(requestedEnd) ||
            requestedStart < 0 ||
            requestedEnd < requestedStart ||
            requestedStart >= stat.size
        ) {
            return text(res, 416, 'range_invalido');
        }

        start = requestedStart;
        end = Math.min(requestedEnd, stat.size - 1);
        status = 206;
    }

    const length = stat.size === 0 ? 0 : end - start + 1;
    const resultHeaders = responseHeaders({
        'Content-Type': config.mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Disposition': downloadName(path.basename(file)),
        'Accept-Ranges': 'bytes',
        'Content-Length': length,
        'X-Download-Options': 'noopen'
    });

    if (status === 206) {
        resultHeaders['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }

    res.writeHead(status, resultHeaders);

    if (!length) return res.end();

    const input = fs.createReadStream(file, { start, end });
    input.on('error', () => res.destroy());
    input.pipe(res);
}

async function downloadFolder(req, res, url, ip) {
    const release = startTransfer(ip);
    res.once('close', release);

    const relative = url.searchParams.get('path') || '';
    const folder = await files.existingPath(relative);

    if (!folder) return text(res, 404, 'pasta_nao_encontrada');

    const stat = await fs.promises.stat(folder);
    if (!stat.isDirectory()) return text(res, 400, 'nao_e_pasta');

    res.writeHead(200, responseHeaders({
        'Content-Type': 'application/zip',
        'Content-Disposition': downloadName(`${path.basename(folder)}.zip`),
        'Transfer-Encoding': 'chunked'
    }));

    try {
        await sendFolderZip(res, folder);
        if (!res.destroyed) res.end();
    } catch (error) {
        if (!res.headersSent) fail(res, error);
        else res.destroy();
    }
}

function openBrowser(url) {
    try {
        let child;

        if (process.platform === 'win32') {
            child = spawn('cmd.exe', ['/c', 'start', '', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
        } else if (process.platform === 'darwin') {
            child = spawn('open', [url], {
                detached: true,
                stdio: 'ignore'
            });
        } else {
            child = spawn('xdg-open', [url], {
                detached: true,
                stdio: 'ignore'
            });
        }

        child.unref();
    } catch (_) {}
}

async function handle(req, res) {
    const ip = normalizeIp(req.socket.remoteAddress);

    if (!isLocalClient(ip)) {
        return fail(res, new Error('rede_local_apenas'));
    }

    limit(requestsByIp, ip, config.maxRequestsPerMinute, 60_000, 'muitos_pedidos');

    if (!validHost(req)) {
        return fail(res, new Error('host_invalido'));
    }

    const rawUrl = String(req.url || '');
    if (rawUrl.length > 8192) return text(res, 414, 'url_muito_grande');

    let url;
    try {
        url = new URL(rawUrl, `http://localhost:${port}`);
    } catch (_) {
        return text(res, 400, 'url_invalida');
    }

    const route = url.pathname;
    const method = req.method;

    if (method === 'GET' && route === '/') {
        const body = await fs.promises.readFile(config.html, 'utf8');
        res.writeHead(200, responseHeaders({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(body)
        }));
        return res.end(body);
    }

    const staticAssets = {
        '/app.js': ['application/javascript; charset=utf-8', config.root + '/app.js'],
        '/styles.css': ['text/css; charset=utf-8', config.root + '/styles.css']
    };

    if (method === 'GET' && staticAssets[route]) {
        const [type, file] = staticAssets[route];
        const body = await fs.promises.readFile(file);
        res.writeHead(200, responseHeaders({
            'Content-Type': type,
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        }));
        return res.end(body);
    }

    if (method === 'POST' && route === '/api/auth') {
        const body = await readJson(req);
        authenticate(req, res, body.pin, ip);
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && route === '/api/logout') {
        requireAuth(req);
        const token = cookieValue(req, 'nyxflash_session');
        sessions.delete(token);
        res.setHeader('Set-Cookie', 'nyxflash_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        return json(res, 200, { ok: true });
    }

    if (method === 'GET' && route === '/api/info') {
        requireAuth(req);
        const info = await files.stats();
        return json(res, 200, {
            ok: true,
            version: config.version,
            port,
            localhost: `http://localhost:${port}`,
            network: localIps().map(ipv4 => `http://${ipv4}:${port}`),
            files: info.files,
            folders: info.folders,
            maxFiles: config.maxFiles
        });
    }

    if (method === 'GET' && route === '/api/tree') {
        requireAuth(req);
        const relative = url.searchParams.get('path') || '';
        const entries = await files.list(relative);
        return json(res, 200, {
            ok: true,
            path: relative,
            entries
        });
    }

    if (method === 'PUT' && route === '/upload') {
        return upload(req, res, url, ip);
    }

    if (method === 'GET' && route === '/download') {
        requireAuth(req);
        return downloadFile(req, res, url, ip);
    }

    if (method === 'GET' && route === '/download-folder') {
        requireAuth(req);
        return downloadFolder(req, res, url, ip);
    }

    if (method === 'POST' && route === '/api/delete') {
        checkMutation(req);
        limit(changesByIp, ip, config.maxChangesPerMinute, 60_000, 'muitos_pedidos');
        const body = await readJson(req);
        await files.deletePath(String(body.path || ''));
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && route === '/api/rename') {
        checkMutation(req);
        limit(changesByIp, ip, config.maxChangesPerMinute, 60_000, 'muitos_pedidos');
        const body = await readJson(req);
        await files.renamePath(String(body.path || ''), String(body.name || ''));
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && route === '/api/mkdir') {
        checkMutation(req);
        limit(changesByIp, ip, config.maxChangesPerMinute, 60_000, 'muitos_pedidos');
        const body = await readJson(req);
        await files.makeFolder(String(body.path || ''));
        return json(res, 200, { ok: true });
    }

    if (method === 'POST' && route === '/api/shutdown') {
        if (ip !== '127.0.0.1') {
            return fail(res, new Error('rede_local_apenas'));
        }

        checkMutation(req);
        json(res, 200, { ok: true });
        setTimeout(() => stop(0), 80);
        return;
    }

    if (method === 'GET' && route === '/favicon.ico') {
        res.writeHead(204, responseHeaders({ 'Content-Length': 0 }));
        return res.end();
    }

    if (!['GET', 'POST', 'PUT'].includes(method)) {
        return fail(res, new Error('metodo_nao_permitido'), 405);
    }

    return text(res, 404, 'nao_encontrado');
}

async function start() {
    accessPin = String(crypto.randomInt(100000, 1000000));
    await fs.promises.mkdir(config.storage, { recursive: true });

    server = http.createServer((req, res) => {
        res.setTimeout(config.transferIdleTimeout);
        handle(req, res).catch(error => {
            if (res.headersSent || res.destroyed) {
                res.destroy();
                return;
            }
            fail(res, error);
        });
    });

    server.requestTimeout = 0;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    server.on('connection', onConnection);

    await new Promise((resolve, reject) => {
        function listening() {
            server.off('error', failed);
            resolve();
        }

        function failed(error) {
            server.off('listening', listening);
            reject(error);
        }

        server.once('listening', listening);
        server.once('error', failed);
        server.listen({
            host: config.host,
            port: config.port,
            exclusive: true
        });
    });

    port = server.address().port;
}

async function stop(code) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (server) {
        try {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
        } catch (_) {}

        try {
            await new Promise(resolve => server.close(resolve));
        } catch (_) {}
    }

    process.exit(code);
}

function clearOldLimits() {
    const now = Date.now();

    for (const [key, item] of batches) {
        if (now - item.time >= config.batchTtl) batches.delete(key);
    }

    for (const [key, item] of requestsByIp) {
        if (now - item.start >= 60_000) requestsByIp.delete(key);
    }

    for (const [key, item] of changesByIp) {
        if (now - item.start >= 60_000) changesByIp.delete(key);
    }

    for (const [key, item] of sessions) {
        if (item.expiresAt <= now) sessions.delete(key);
    }

    for (const [key, item] of loginAttempts) {
        if (now - item.start >= 60_000 && item.lockedUntil <= now) loginAttempts.delete(key);
    }
}

(async () => {
    try {
        await start();

        const localUrl = `http://localhost:${port}`;
        const ips = localIps();

        console.log(`nyXflash ${config.version}`);
        console.log(`PC: ${localUrl}`);
        for (const ip of ips) console.log(`Celular: http://${ip}:${port}`);
        console.log(`Storage: ${config.storage}`);
        console.log(`PIN de acesso: ${accessPin}`);
        console.log('Acesso limitado a rede local + PIN.');
        console.log('Pressione Ctrl+C para encerrar.');

        if (String(process.env.NYXFLASH_NO_BROWSER || '') !== '1') {
            openBrowser(localUrl);
        }

        setInterval(clearOldLimits, 60_000).unref();

        process.on('SIGINT', () => stop(0));
        process.on('SIGTERM', () => stop(0));
        process.on('uncaughtException', error => {
            console.error(`[nyXflash] ${error && error.message ? error.message : error}`);
            stop(1);
        });
        process.on('unhandledRejection', error => {
            console.error(`[nyXflash] ${error && error.message ? error.message : error}`);
            stop(1);
        });
    } catch (error) {
        console.error(`[nyXflash] nao foi possivel iniciar: ${error && error.message ? error.message : error}`);
        process.exit(1);
    }
})();
