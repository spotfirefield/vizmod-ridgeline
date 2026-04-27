// Starts the official Spotfire mods development server.
// Uses Node.js __dirname so it works on UNC paths
// (cmd.exe resets the CWD to C:\Windows for UNC roots).

// chokidar's recursive watcher fails on UNC / mapped-drive paths with a
// variety of noisy errors ("UNKNOWN: unknown error, watch", "ECONNRESET",
// "EPERM", etc.). Any one of these can crash the dev server because
// FSWatcher emits them as uncaught 'error' events. Live-reload is only a
// convenience here, so swallow them at source.
const fs = require("fs");
const _origWatch = fs.watch;
fs.watch = function patchedWatch(...args) {
    const w = _origWatch.apply(this, args);
    w.on("error", () => { /* silent */ });
    return w;
};

process.on("uncaughtException", (err) => {
    if (err && /watch/i.test(String(err.message || ""))) return;
    if (err && ["ECONNRESET", "UNKNOWN", "EPERM", "ENOTSUP", "EBUSY"].includes(err.code)) return;
    if (err && (err.syscall === "watch" || err.syscall === "scandir")) return;
    console.error("uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
    if (err && /watch/i.test(String(err && err.message || ""))) return;
});

const devServer = require("@spotfire/mods-dev-server/server");

devServer.start({
    root: __dirname,
    port: Number(process.env.PORT) || 8090,
    open: false,
    path: "/mod-manifest.json"
});
