# nyXflash

A browser-based local file manager built with Node.js.
The concept is simple: turn your PC into a small file server.
You run nyXflash and access everything via your browser—no need to install a mobile app.
To access it from your phone, use `http://PC-IP-ADDRESS:3000`.
Both devices must be on the same local network.
Upon startup, the terminal displays a PIN required to access the interface.
You can transfer files from your phone to your PC and download them from your PC to your phone.
It also supports batch uploads and folder selection.
The project accepts virtually any file type without blocking specific extensions.
Images, videos, ZIPs, PDFs, programs, code, and extensionless files all work.
Files are stored directly on your PC within the nyXflash storage directory.
Nothing is sent to the cloud or any external server.
You can also create folders, rename files, and delete items via the interface.
Folders can be downloaded as ZIP archives.
Uploads utilize streaming and support `chunked` requests.
This significantly improves compatibility with certain mobile browsers.
The server uses temporary files before finalizing an upload.
This ensures that incomplete uploads do not become permanent files.
The project also includes protection against path traversal attacks (e.g., `../` or `../../`).
PIN-based authentication and session management control access and modifications.
Configurable limits are in place to prevent abuse and disk space exhaustion.
The project's main files are:
`server.js` — server, routes, authentication, and transfers.
`storage.js` — file and folder handling, plus path validation.
`zip.js` — ZIP archive creation.
`config.js` — configuration settings and limits.
`index.html`, `app.js`, and `styles.css` — browser interface.
`start.bat` — quick startup script for Windows.
