#include <windows.h>
__declspec(dllimport) HINSTANCE WINAPI ShellExecuteA(HWND, LPCSTR, LPCSTR, LPCSTR, LPCSTR, INT);

static int file_exists(const char *path) {
    DWORD a = GetFileAttributesA(path);
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static int quote_arg(const char *src, char *dst, SIZE_T cap) {
    SIZE_T p = 0;
    if (!src || !dst || cap < 3) return 0;
    dst[p++] = '"';
    SIZE_T slashes = 0;
    for (SIZE_T i = 0;; ++i) {
        char c = src[i];
        if (c == '\\') {
            slashes++;
            continue;
        }
        if (c == '"') {
            if (p + slashes * 2 + 2 >= cap) return 0;
            for (SIZE_T j = 0; j < slashes * 2 + 1; ++j) dst[p++] = '\\';
            dst[p++] = '"';
            slashes = 0;
            continue;
        }
        if (c == 0) {
            if (p + slashes * 2 + 2 > cap) return 0;
            for (SIZE_T j = 0; j < slashes * 2; ++j) dst[p++] = '\\';
            dst[p++] = '"';
            dst[p] = 0;
            return 1;
        }
        if (p + slashes + 2 >= cap) return 0;
        while (slashes--) dst[p++] = '\\';
        slashes = 0;
        dst[p++] = c;
    }
}

static char *load_text_file(const char *path) {
    HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER size;
    if (!GetFileSizeEx(h, &size) || size.QuadPart < 1 || size.QuadPart > 8191) { CloseHandle(h); return NULL; }
    char *buf = (char*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)size.QuadPart + 1);
    if (!buf) { CloseHandle(h); return NULL; }
    DWORD got = 0;
    BOOL ok = ReadFile(h, buf, (DWORD)size.QuadPart, &got, NULL);
    CloseHandle(h);
    if (!ok || got == 0) { HeapFree(GetProcessHeap(), 0, buf); return NULL; }
    buf[got] = 0;
    return buf;
}

static int wait_ready_url(const char *path, char **url) {
    for (int i = 0; i < 300; ++i) {
        char *value = load_text_file(path);
        if (value && value[0] == 'h') { *url = value; return 1; }
        if (value) HeapFree(GetProcessHeap(), 0, value);
        Sleep(100);
    }
    return 0;
}

static char *join_arg_command(int argc, char **argv, const char *node, const char *server) {
    size_t need = 32 + lstrlenA(node) * 3 + lstrlenA(server) * 3;
    for (int i = 1; i < argc; ++i) need += 12 + lstrlenA(argv[i]) * 3;
    char *cmd = (char*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, need);
    if (!cmd) return NULL;
    char *q = cmd;
    char *tmp = (char*)HeapAlloc(GetProcessHeap(), 0, need);
    if (!tmp) { HeapFree(GetProcessHeap(), 0, cmd); return NULL; }
    if (!quote_arg(node, tmp, need)) { HeapFree(GetProcessHeap(), 0, tmp); HeapFree(GetProcessHeap(), 0, cmd); return NULL; }
    lstrcpyA(q, tmp); q += lstrlenA(tmp); *q++ = ' ';
    if (!quote_arg(server, tmp, need)) { HeapFree(GetProcessHeap(), 0, tmp); HeapFree(GetProcessHeap(), 0, cmd); return NULL; }
    lstrcpyA(q, tmp); q += lstrlenA(tmp);
    for (int i = 1; i < argc; ++i) {
        lstrcpyA(q, " --import "); q += 10;
        if (!quote_arg(argv[i], tmp, need)) { HeapFree(GetProcessHeap(), 0, tmp); HeapFree(GetProcessHeap(), 0, cmd); return NULL; }
        lstrcpyA(q, tmp); q += lstrlenA(tmp);
    }
    *q = 0;
    HeapFree(GetProcessHeap(), 0, tmp);
    return cmd;
}

int main(int argc, char **argv) {
    char base[MAX_PATH * 4];
    DWORD n = GetModuleFileNameA(NULL, base, sizeof(base));
    if (!n || n >= sizeof(base)) return 1;
    for (DWORD i = n; i > 0; --i) {
        if (base[i - 1] == '\\' || base[i - 1] == '/') { base[i - 1] = 0; break; }
    }

    char node[MAX_PATH * 4];
    char server[MAX_PATH * 4];
    char ready[MAX_PATH * 4];
    lstrcpyA(node, base); lstrcatA(node, "\\runtime\\node.exe");
    lstrcpyA(server, base); lstrcatA(server, "\\server\\server.js");
    lstrcpyA(ready, base); lstrcatA(ready, "\\nyXflash.url");

    if (!file_exists(node)) {
        MessageBoxA(NULL, "runtime\\node.exe nao encontrado. Execute prepare_runtime.bat.", "nyXflash", MB_OK | MB_ICONERROR);
        return 1;
    }
    if (!file_exists(server)) {
        MessageBoxA(NULL, "server\\server.js nao encontrado.", "nyXflash", MB_OK | MB_ICONERROR);
        return 1;
    }

    DeleteFileA(ready);
    char *command = join_arg_command(argc, argv, node, server);
    if (!command) return 1;

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    BOOL ok = CreateProcessA(node, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, base, &si, &pi);
    HeapFree(GetProcessHeap(), 0, command);
    if (!ok) {
        char msg[256];
        wsprintfA(msg, "Nao foi possivel iniciar o servidor. Codigo: %lu", GetLastError());
        MessageBoxA(NULL, msg, "nyXflash", MB_OK | MB_ICONERROR);
        return 1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    char *url = NULL;
    if (!wait_ready_url(ready, &url)) {
        MessageBoxA(NULL, "O nyXflash nao encontrou uma rede Wi-Fi privada ativa. Ligue o Wi-Fi e execute o nyXflash.exe novamente.", "nyXflash", MB_OK | MB_ICONWARNING);
        return 1;
    }
    HINSTANCE result = ShellExecuteA(NULL, "open", url, NULL, base, SW_SHOWNORMAL);
    HeapFree(GetProcessHeap(), 0, url);
    if ((INT_PTR)result <= 32) {
        MessageBoxA(NULL, "O servidor esta ativo, mas o navegador nao abriu automaticamente.", "nyXflash", MB_OK | MB_ICONWARNING);
    }
    return 0;
}
