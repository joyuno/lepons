// The map's model, painter and summaries are the cockpit's own files. Expo sets
// up outside imports by itself only in a workspace monorepo, and this repo is not one.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// Metro does not see files outside its watch folders; shared/ holds the path finder chat taps use (term-paths.ts).
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, "../cockpit/src/renderer/workflowmap"), path.resolve(__dirname, "../cockpit/src/shared")];
// model.ts's d3-force must resolve from here: EAS installs mobile/ only, and Metro
// does not read cockpit/node_modules either, so without this no export finds it.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
