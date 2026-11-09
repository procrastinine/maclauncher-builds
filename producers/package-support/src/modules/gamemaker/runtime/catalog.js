const { upstreamRevision } = require("../../../../../../lib/projects.mjs");
const BUTTERSCOTCH_REVISION = upstreamRevision("butterscotch", "butterscotch");
const BUTTERSCOTCH_ARGUMENTS_VERSION = "MCLv1-1007";

const BUTTERSCOTCH_BUILDS = Object.freeze([
  Object.freeze({ version: BUTTERSCOTCH_ARGUMENTS_VERSION, upstreamRevision: BUTTERSCOTCH_REVISION,
    sourceKind: "commit", backend: "appkit", renderer: "legacy-opengl", videoBackend: "none",
    minimumMacOS: "13.0", gameArguments: "repeat-game-arg-v1",
    wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] })
]);

module.exports = { BUTTERSCOTCH_REVISION, BUTTERSCOTCH_ARGUMENTS_VERSION, BUTTERSCOTCH_BUILDS };
