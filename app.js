const state = {
            path: '',
            entries: [],
            jobs: [],
            nextJob: 0,
            activeJobs: 0,
            batch: '',
            authenticated: false,
            maxFiles: 0
        };

        const byId = id => document.getElementById(id);

        function encode(value) {
            return encodeURIComponent(value);
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[char]);
        }

        function formatSize(value) {
            if (value === null || value === undefined) return '';
            if (value < 1024) return `${value} B`;

            const units = ['KB', 'MB', 'GB', 'TB'];
            let size = value;
            let unit = -1;

            do {
                size /= 1024;
                unit += 1;
            } while (size >= 1024 && unit < units.length - 1);

            return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
        }

        async function request(url, options = {}) {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...(options.headers || {})
                },
                cache: 'no-store',
                credentials: 'same-origin'
            });

            if (!response.ok) {
                let message = `erro ${response.status}`;
                try {
                    const data = await response.json();
                    message = data.message || data.error || message;
                } catch (_) {}

                if (response.status === 401 && url !== '/api/auth') {
                    state.authenticated = false;
                    showLogin('sua sessao expirou.');
                }

                throw new Error(message);
            }

            const type = response.headers.get('content-type') || '';
            return type.includes('application/json') ? response.json() : {};
        }

        function showLogin(message = '') {
            document.body.classList.add('locked');
            byId('loginModal').hidden = false;
            byId('loginStatus').textContent = message;
            setTimeout(() => byId('pin').focus(), 0);
        }

        function hideLogin() {
            document.body.classList.remove('locked');
            byId('loginModal').hidden = true;
            byId('loginStatus').textContent = '';
        }

        async function login() {
            const pin = byId('pin').value.trim();
            if (!/^\d{6}$/.test(pin)) {
                byId('loginStatus').textContent = 'digite os 6 numeros do PIN.';
                return;
            }

            byId('loginStatus').textContent = 'verificando...';
            byId('login').disabled = true;

            try {
                await request('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                state.authenticated = true;
                byId('pin').value = '';
                hideLogin();
                await loadInfo();
                await load();
            } catch (error) {
                byId('loginStatus').textContent = error.message;
            } finally {
                byId('login').disabled = false;
            }
        }

        function newBatch() {
            if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
                return globalThis.crypto.randomUUID().replaceAll('-', '');
            }
            const bytes = new Uint8Array(24);
            if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
                globalThis.crypto.getRandomValues(bytes);
            } else {
                for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
            }
            return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        }

        function selectedEntries() {
            const indexes = [...document.querySelectorAll('#list .check:checked')]
                .map(input => Number(input.dataset.index));

            return indexes
                .map(index => state.entries[index])
                .filter(Boolean);
        }

        function openItem(item) {
            if (item.directory) {
                state.path = item.path;
                load();
            }
        }

        function renderPath() {
            const parts = state.path ? state.path.split('/') : [];
            let html = '<button type="button" data-path="">raiz</button>';

            parts.forEach((part, index) => {
                const full = parts.slice(0, index + 1).join('/');
                html += `<span>/</span><button type="button" data-path="${escapeHtml(full)}">${escapeHtml(part)}</button>`;
            });

            byId('path').innerHTML = html;
        }

        function render() {
            const query = byId('search').value.trim().toLowerCase();
            const rows = state.entries
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => !query || item.name.toLowerCase().includes(query));

            renderPath();

            if (!rows.length) {
                byId('list').innerHTML = '<div class="empty">pasta vazia</div>';
                byId('count').textContent = '0 itens';
                return;
            }

            byId('list').innerHTML = rows.map(({ item, index }) => {
                const icon = item.directory ? '📁' : '📄';
                const info = item.directory ? 'pasta' : formatSize(item.size);
                const action = item.directory ? 'zip' : 'baixar';

                return `
                    <div class="row" data-index="${index}">
                        <input class="check" type="checkbox" data-index="${index}">
                        <button type="button" class="open-item" data-index="${index}">
                            <div class="name">${icon} ${escapeHtml(item.name)}</div>
                            <div class="meta">${info}</div>
                        </button>
                        <div class="actions">
                            <button type="button" class="btn small download-item" data-index="${index}">${action}</button>
                            <button type="button" class="btn small rename-item" data-index="${index}">renomear</button>
                            <button type="button" class="btn small danger delete-item" data-index="${index}">excluir</button>
                        </div>
                    </div>`;
            }).join('');

            byId('count').textContent = `${rows.length} itens`;
        }

        async function loadInfo() {
            const data = await request('/api/info');
            state.maxFiles = Number(data.maxFiles || 0);
            byId('access').textContent = location.host;
            byId('limitInfo').textContent = state.maxFiles > 0
                ? `${state.maxFiles} arquivos por envio`
                : 'quantidade de arquivos sem limite fixo';
        }

        async function load() {
            try {
                const data = await request(`/api/tree?path=${encode(state.path)}`);
                state.entries = data.entries;
                render();
                byId('status').textContent = '';
            } catch (error) {
                byId('list').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
                byId('status').textContent = error.message;
            }
        }

        function addJob(job) {
            const box = document.createElement('div');
            box.className = 'job';
            box.innerHTML = `
                <div class="jobtop">
                    <span>${escapeHtml(job.path)}</span>
                    <span class="pct">0%</span>
                </div>
                <div class="track"><div class="fill"></div></div>`;
            byId('jobs').prepend(box);
            return box;
        }

        function sendFile(job) {
            return new Promise(resolve => {
                const box = addJob(job);
                const xhr = new XMLHttpRequest();

                xhr.open('PUT', `/upload?path=${encode(job.path.replaceAll('\\', '/'))}`);
                xhr.withCredentials = true;
                xhr.timeout = 0;
                xhr.setRequestHeader('X-NYXFLASH-BATCH', state.batch);
                xhr.setRequestHeader('Content-Type', job.file.type || 'application/octet-stream');

                xhr.upload.onprogress = event => {
                    if (!event.lengthComputable) return;
                    const percent = Math.round((event.loaded / event.total) * 100);
                    box.querySelector('.pct').textContent = `${percent}%`;
                    box.querySelector('.fill').style.width = `${percent}%`;
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        box.querySelector('.pct').textContent = 'ok';
                        box.querySelector('.fill').style.width = '100%';
                    } else {
                        let message = `erro ${xhr.status}`;
                        try {
                            const data = JSON.parse(xhr.responseText);
                            message = data.message || data.error || message;
                        } catch (_) {}
                        box.querySelector('.pct').textContent = message;
                    }
                    resolve();
                };

                xhr.onerror = () => {
                    box.querySelector('.pct').textContent = 'erro de conexao';
                    box.title = 'o navegador nao conseguiu completar a conexao.';
                    resolve();
                };

                xhr.onabort = () => {
                    box.querySelector('.pct').textContent = 'cancelado';
                    resolve();
                };

                xhr.ontimeout = () => {
                    box.querySelector('.pct').textContent = 'tempo esgotado';
                    resolve();
                };

                xhr.send(job.file);
            });
        }

        function pump() {
            while (state.activeJobs < 2 && state.nextJob < state.jobs.length) {
                const job = state.jobs[state.nextJob];
                state.nextJob += 1;
                state.activeJobs += 1;

                sendFile(job).finally(() => {
                    state.activeJobs -= 1;
                    load();
                    pump();
                });
            }
        }

        function queueUpload(items) {
            if (!items.length) return;

            if (state.activeJobs || state.nextJob < state.jobs.length) {
                alert('aguarde o envio atual terminar.');
                return;
            }

            if (state.maxFiles > 0 && items.length > state.maxFiles) {
                alert(`envie no maximo ${state.maxFiles} arquivos por vez.`);
                return;
            }

            state.jobs = items;
            state.nextJob = 0;
            state.batch = newBatch();
            pump();
        }

        function download(item) {
            const route = item.directory ? '/download-folder' : '/download';
            window.location.href = `${route}?path=${encode(item.path)}`;
        }

        async function rename(item) {
            const currentName = item.name;
            const newName = prompt('novo nome:', currentName);
            if (!newName || newName === currentName) return;

            try {
                await request('/api/rename', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        path: item.path,
                        name: newName
                    })
                });
                await load();
            } catch (error) {
                alert(error.message);
            }
        }

        async function remove(item) {
            if (!confirm(`excluir "${item.name}"?`)) return;

            try {
                await request('/api/delete', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ path: item.path })
                });
                await load();
            } catch (error) {
                alert(error.message);
            }
        }

        async function createFolder() {
            const name = prompt('nome da pasta:');
            if (!name) return;

            const folder = state.path ? `${state.path}/${name}` : name;

            try {
                await request('/api/mkdir', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ path: folder })
                });
                await load();
            } catch (error) {
                alert(error.message);
            }
        }

        async function deleteSelected() {
            const items = selectedEntries();
            if (!items.length) return;
            if (!confirm(`excluir ${items.length} item(ns)?`)) return;

            for (const item of items) {
                try {
                    await request('/api/delete', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ path: item.path })
                    });
                } catch (error) {
                    alert(error.message);
                    break;
                }
            }

            await load();
        }

        function downloadSelected() {
            const items = selectedEntries();
            for (const item of items) download(item);
        }

        byId('list').addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;

            if (button.dataset.path !== undefined) {
                state.path = button.dataset.path;
                load();
                return;
            }

            const index = Number(button.dataset.index);
            if (!Number.isInteger(index) || !state.entries[index]) return;

            const item = state.entries[index];

            if (button.classList.contains('open-item')) {
                openItem(item);
            } else if (button.classList.contains('download-item')) {
                download(item);
            } else if (button.classList.contains('rename-item')) {
                rename(item);
            } else if (button.classList.contains('delete-item')) {
                remove(item);
            }
        });

        byId('newFolder').addEventListener('click', createFolder);
        byId('downloadSelected').addEventListener('click', downloadSelected);
        byId('deleteSelected').addEventListener('click', deleteSelected);
        byId('refresh').addEventListener('click', async () => {
            if (!state.authenticated) return showLogin();
            try { await loadInfo(); await load(); } catch (_) {}
        });
        byId('logout').addEventListener('click', async () => {
            try { await request('/api/logout', { method: 'POST' }); } catch (_) {}
            state.authenticated = false;
            showLogin();
        });
        byId('login').addEventListener('click', login);
        byId('pin').addEventListener('keydown', event => {
            if (event.key === 'Enter') login();
        });
        byId('pin').addEventListener('input', event => {
            event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
        });
        byId('search').addEventListener('input', render);

        byId('files').addEventListener('change', event => {
            const files = [...event.target.files];
            if (files.length) {
                queueUpload(files.map(file => ({
                    file,
                    path: file.name
                })));
            }
            event.target.value = '';
        });

        byId('folder').addEventListener('change', event => {
            const files = [...event.target.files];
            if (files.length) {
                queueUpload(files.map(file => ({
                    file,
                    path: file.webkitRelativePath || file.name
                })));
            }
            event.target.value = '';
        });

        for (const type of ['dragenter', 'dragover']) {
            byId('drop').addEventListener(type, event => {
                event.preventDefault();
                byId('drop').classList.add('drag');
            });
        }

        byId('drop').addEventListener('dragleave', () => {
            byId('drop').classList.remove('drag');
        });

        byId('drop').addEventListener('drop', event => {
            event.preventDefault();
            byId('drop').classList.remove('drag');

            const files = [...event.dataTransfer.files];
            if (!files.length) return;

            queueUpload(files.map(file => ({
                file,
                path: file.name
            })));
        });

        showLogin();
