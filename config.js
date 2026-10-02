const path = require('path');

const root = __dirname;
const envNumber = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const gib = value => value * 1024 * 1024 * 1024;
const mib = value => value * 1024 * 1024;

module.exports = {
    root,
    storage: path.join(root, 'storage'),
    html: path.join(root, 'index.html'),
    port: Number(process.env.NYXFLASH_PORT || 3000),
    host: '0.0.0.0',
    version: '6.0.3',
    sessionTtl: 8 * 60 * 60 * 1000,
    loginAttemptsPerMinute: 5,
    loginLockMs: 60 * 1000,
    maxFiles: envNumber('NYXFLASH_MAX_FILES', 50),
    maxFileSize: envNumber('NYXFLASH_MAX_FILE_SIZE', 0),
    maxJsonSize: 1024 * 1024,
    maxUploads: envNumber('NYXFLASH_MAX_UPLOADS', 3),
    maxUploadsPerIp: envNumber('NYXFLASH_MAX_UPLOADS_PER_IP', 2),
    maxConnections: envNumber('NYXFLASH_MAX_CONNECTIONS', 80),
    maxConnectionsPerIp: envNumber('NYXFLASH_MAX_CONNECTIONS_PER_IP', 20),
    maxRequestsPerMinute: envNumber('NYXFLASH_MAX_REQUESTS_PER_MINUTE', 240),
    maxChangesPerMinute: envNumber('NYXFLASH_MAX_CHANGES_PER_MINUTE', 80),
    maxTreeEntries: envNumber('NYXFLASH_MAX_TREE_ENTRIES', 10000),
    maxStatsEntries: envNumber('NYXFLASH_MAX_STATS_ENTRIES', 25000),
    maxZipFiles: envNumber('NYXFLASH_MAX_ZIP_FILES', 20000),
    maxZipBytes: envNumber('NYXFLASH_MAX_ZIP_BYTES', 3500 * 1024 * 1024),
    maxPathLength: 2048,
    maxNameLength: 255,
    maxFolderDepth: 64,
    maxTransfers: envNumber('NYXFLASH_MAX_TRANSFERS', 8),
    maxTransfersPerIp: envNumber('NYXFLASH_MAX_TRANSFERS_PER_IP', 4),
    maxActiveUploadBytes: envNumber('NYXFLASH_MAX_ACTIVE_UPLOAD_BYTES', gib(16)),
    minFreeSpace: envNumber('NYXFLASH_MIN_FREE_SPACE', mib(256)),
    transferIdleTimeout: 15 * 60 * 1000,
    batchTtl: 30 * 60 * 1000,
    mime: {
        '.7z': 'application/x-7z-compressed',
        '.avi': 'video/x-msvideo',
        '.bmp': 'image/bmp',
        '.csv': 'text/csv; charset=utf-8',
        '.gif': 'image/gif',
        '.gz': 'application/gzip',
        '.html': 'text/html; charset=utf-8',
        '.ico': 'image/x-icon',
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.m4a': 'audio/mp4',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.tar': 'application/x-tar',
        '.txt': 'text/plain; charset=utf-8',
        '.wav': 'audio/wav',
        '.webm': 'video/webm',
        '.webp': 'image/webp',
        '.zip': 'application/zip'
    }
};
