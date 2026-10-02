const fs = require('fs');
const path = require('path');

module.exports = function createStorage(root, limits) {
    function validName(name) {
        const value = String(name || '').normalize('NFC');
        if (!value || value.length > limits.maxNameLength) return false;
        if (value === '.' || value === '..') return false;
        if (value.includes('\0') || value.includes('/') || value.includes('\\')) return false;
        if (/[\x00-\x1F]/.test(value)) return false;

        if (process.platform === 'win32') {
            if (/[<>:"|?*]/.test(value) || /[. ]$/.test(value)) return false;
            const base = value.split('.')[0].toUpperCase();
            if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) return false;
        }

        return true;
    }

    function safePath(value, allowEmpty = false) {
        const text = String(value || '').normalize('NFC').replace(/\\/g, '/');
        if (text.length > limits.maxPathLength) return null;
        if (!text) return allowEmpty ? '' : null;
        if (text.includes('\0') || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null;

        const parts = text.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || !validName(part))) {
            return null;
        }

        return parts.join('/');
    }

    function inside(file) {
        const base = path.resolve(root);
        const target = path.resolve(file);
        return target === base || target.startsWith(base + path.sep);
    }

    async function existingPath(relative) {
        const clean = safePath(relative, true);
        if (clean === null) return null;

        const target = clean
            ? path.resolve(root, ...clean.split('/'))
            : path.resolve(root);

        if (!inside(target)) return null;

        try {
            const real = await fs.promises.realpath(target);
            const stat = await fs.promises.lstat(real);
            if (stat.isSymbolicLink()) return null;
            return inside(real) ? real : null;
        } catch (_) {
            return null;
        }
    }

    async function ensureDirectory(relative) {
        const clean = safePath(relative, true);
        if (clean === null) throw new Error('caminho_invalido');
        if (!clean) return path.resolve(root);

        const parts = clean.split('/');
        if (parts.length > limits.maxFolderDepth) throw new Error('caminho_invalido');

        let current = path.resolve(root);

        for (const part of parts) {
            current = path.join(current, part);
            if (!inside(current)) throw new Error('caminho_invalido');

            try {
                const stat = await fs.promises.lstat(current);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new Error('pasta_invalida');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await fs.promises.mkdir(current);
            }
        }

        return current;
    }

    async function uploadTarget(relative) {
        const clean = safePath(relative);
        if (!clean) return null;

        const parent = path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean);
        const folder = await ensureDirectory(parent);
        const target = path.join(folder, path.basename(clean));

        if (!inside(target)) return null;

        try {
            const stat = await fs.promises.lstat(target);
            if (stat.isSymbolicLink()) return null;
            throw new Error('arquivo_ja_existe');
        } catch (error) {
            if (error.message === 'arquivo_ja_existe') throw error;
            if (error.code !== 'ENOENT') throw error;
        }

        return target;
    }

    async function enoughSpace(size) {
        if (typeof fs.promises.statfs !== 'function') return true;

        try {
            const info = await fs.promises.statfs(root);
            const free = info.bavail * info.bsize;
            return Number.isFinite(free) && free >= size + limits.minFreeSpace;
        } catch (_) {
            return true;
        }
    }

    async function list(relative) {
        const folder = await existingPath(relative);
        if (!folder) throw new Error('caminho_nao_encontrado');

        const stat = await fs.promises.stat(folder);
        if (!stat.isDirectory()) throw new Error('nao_e_pasta');

        const entries = await fs.promises.readdir(folder, { withFileTypes: true });
        if (entries.length > limits.maxTreeEntries) throw new Error('muitos_arquivos');

        const result = [];

        for (const entry of entries) {
            if (entry.name === '.tmp' || entry.isSymbolicLink()) continue;

            const full = path.join(folder, entry.name);
            let info;

            try {
                info = await fs.promises.lstat(full);
            } catch (_) {
                continue;
            }

            if (!info.isFile() && !info.isDirectory()) continue;

            result.push({
                name: entry.name,
                path: relative ? `${relative}/${entry.name}` : entry.name,
                directory: info.isDirectory(),
                size: info.isFile() ? info.size : null,
                modified: info.mtimeMs
            });
        }

        result.sort((a, b) => {
            if (a.directory !== b.directory) return a.directory ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, {
                numeric: true,
                sensitivity: 'base'
            });
        });

        return result;
    }

    async function stats() {
        let files = 0;
        let folders = 0;
        let seen = 0;

        async function walk(folder, depth) {
            if (depth > limits.maxFolderDepth) throw new Error('caminho_invalido');

            const entries = await fs.promises.readdir(folder, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name === '.tmp' || entry.isSymbolicLink()) continue;

                seen += 1;
                if (seen > limits.maxStatsEntries) throw new Error('muitos_arquivos');

                const full = path.join(folder, entry.name);

                if (entry.isDirectory()) {
                    folders += 1;
                    await walk(full, depth + 1);
                } else if (entry.isFile()) {
                    files += 1;
                }
            }
        }

        await walk(root, 0);
        return { files, folders };
    }

    async function removeEntry(target, depth = 0) {
        if (depth > limits.maxFolderDepth) throw new Error('caminho_invalido');

        const stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink()) throw new Error('atalho_nao_suportado');

        if (stat.isDirectory()) {
            const entries = await fs.promises.readdir(target, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name === '.tmp' || entry.isSymbolicLink()) {
                    if (entry.isSymbolicLink()) throw new Error('atalho_nao_suportado');
                    continue;
                }

                await removeEntry(path.join(target, entry.name), depth + 1);
            }

            await fs.promises.rmdir(target);
            return;
        }

        if (stat.isFile()) {
            await fs.promises.unlink(target);
        }
    }

    async function deletePath(relative) {
        const target = await existingPath(relative);
        if (!target || path.resolve(target) === path.resolve(root)) {
            throw new Error('caminho_invalido');
        }
        await removeEntry(target);
    }

    async function renamePath(relative, newName) {
        if (!validName(newName)) throw new Error('nome_invalido');

        const target = await existingPath(relative);
        if (!target || path.resolve(target) === path.resolve(root)) {
            throw new Error('caminho_nao_encontrado');
        }

        const parentReal = await fs.promises.realpath(path.dirname(target));
        if (!inside(parentReal)) throw new Error('caminho_invalido');

        const destination = path.join(parentReal, newName);
        if (!inside(destination)) throw new Error('caminho_invalido');

        try {
            await fs.promises.lstat(destination);
            throw new Error('nome_ja_existe');
        } catch (error) {
            if (error.message === 'nome_ja_existe') throw error;
            if (error.code !== 'ENOENT') throw error;
        }

        await fs.promises.rename(target, destination);
    }

    async function makeFolder(relative) {
        const clean = safePath(relative);
        if (!clean) throw new Error('nome_invalido');

        const parts = clean.split('/');
        if (parts.length > limits.maxFolderDepth) throw new Error('caminho_invalido');

        const name = parts.pop();
        const parent = parts.join('/');
        await ensureDirectory(parent);

        const parentPath = parent
            ? path.resolve(root, ...parent.split('/'))
            : path.resolve(root);
        const parentReal = await fs.promises.realpath(parentPath);

        if (!inside(parentReal)) throw new Error('caminho_invalido');

        const target = path.join(parentReal, name);
        if (!inside(target)) throw new Error('caminho_invalido');

        await fs.promises.mkdir(target);
    }

    return {
        validName,
        safePath,
        existingPath,
        ensureDirectory,
        uploadTarget,
        enoughSpace,
        list,
        stats,
        deletePath,
        renamePath,
        makeFolder
    };
};
