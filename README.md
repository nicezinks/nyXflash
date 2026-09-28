# nyXflash

nyXflash is essentially a simple way to turn your PC into a network drive accessible via your local network.
The concept is straightforward: you launch the program, and it starts a local server.
It then opens your browser and displays the address that other devices can use to connect.
On your mobile phone, simply visit that address or scan the QR code shown on the screen.
As long as you are on the same Wi-Fi network, you can access the files directly through the browser.
There are no accounts, online dashboards, or cloud services involved.
Files remain in the PC's own storage folder.
So, anything you send from your phone is saved there for later use.
The interface allows you to browse folders and view available files.
You can also search by name when a folder is crowded.
It supports uploading individual files as well as entire folders.
You can create new folders directly within the browser.
Renaming and deleting files and folders is also supported.
If you need to retrieve something, you can download the file directly.
Folders can also be downloaded as ZIP archives.
You can even select multiple items to perform batch actions.
The server uses streaming, so it doesn't try to load a massive file entirely into RAM.
This is particularly helpful when dealing with larger files.
The server runs locally using Node.js.
The C program handles starting the server and launching the browser.
It also retrieves the network address and monitors the Wi-Fi connection.
The port is selected automatically to avoid conflicts whenever possible.
Each session uses an access address that includes a temporary token.
This prevents the dashboard from being accessible via the URL without the correct token.
To build the project, first ensure the Node runtime is available.
Then, compile `src/main.c` using an environment that includes GCC/MinGW-w64.
In practice, once compiled, you simply run `nyXflash.exe` to start using it. The project was designed to be simple to use, without relying on an external backend.
It’s really about just opening it up, logging in on your phone, and swapping files—without any unnecessary bells and whistles.
