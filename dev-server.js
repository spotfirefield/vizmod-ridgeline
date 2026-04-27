// Starts the official Spotfire mods development server.
// Uses Node.js __dirname so it works on UNC paths
// (cmd.exe resets the CWD to C:\Windows for UNC roots).
const devServer = require("@spotfire/mods-dev-server/server");

// Swallow unhandled FSWatcher errors that fire constantly on UNC mounts
// (chokidar/fs.watch is unreliable across SMB) so they don't crash the server.
process.on("uncaughtException", (err) => {
    if (err && (err.syscall === "watch" || err.syscall === "scandir")) return;
    console.error("uncaughtException:", err);
});

devServer.start({
    root: __dirname,
    port: Number(process.env.PORT) || 8090,
    open: false,
    path: "/mod-manifest.json"
});
