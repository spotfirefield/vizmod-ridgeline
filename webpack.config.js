// Webpack build for the Joy Plot Spotfire Mod.
//
// Produces a single self-contained IIFE bundle at build/main.js that the
// Spotfire host loads via a <script> tag from index.html. The bundle inlines
// all third-party dependencies declared in package.json (currently d3), so no
// separate vendor.min.js is shipped.

const path = require("path");

module.exports = (_env, argv) => {
  const isProd = argv.mode === "production";
  return {
    target: "web",
    entry: "./src/main.js",
    output: {
      path: path.resolve(__dirname, "build"),
      filename: "main.js",
      iife: true,
      clean: true,
    },
    devtool: isProd ? "source-map" : "eval-cheap-module-source-map",
    resolve: {
      extensions: [".js"],
    },
    performance: {
      hints: false,
    },
    // Webpack's native fs watcher does not detect file changes on Windows
    // UNC shares (\\server\share\...), which is where this project lives.
    // Force polling so `webpack --watch` / `npm run dev` actually rebuilds
    // when files change. Polling is only enabled in dev (watch) mode.
    watchOptions: {
      poll: 1000,                 // check every 1s
      aggregateTimeout: 200,      // debounce burst saves
      ignored: ["**/node_modules", "**/build"],
    },
  };
};
