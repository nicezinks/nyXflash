# nyXflash

A browser-based local file manager.

## Access

Without a PC:

`http://localhost:3000`

On mobile, use the address `http://PC-IP-ADDRESS:3000` while both devices are on the same local network.

The server only accepts clients from the local network and is not designed to be exposed directly to the internet.

## Limits

- 7 files per batch
- 4 GiB per file
- 2 simultaneous uploads per IP
- 8 simultaneous uploads total
- 8 simultaneous downloads total
- 180 requests per minute per IP
- 60 modifications per minute per IP
- 5,000 items per displayed list
- 20,000 files per ZIP
- 3.5 GiB per ZIP

## Structure

- `server.js` handles the server and routes
- `storage.js` handles files and paths
- `zip.js` assembles ZIPs without external dependencies
- `config.js` centralizes ports and limits
- `index.html` and the interface
