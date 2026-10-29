// Native library input validation shared by the Steam bridge producers.
const Bundle = require("../bundled-native");
const Native = require("../local-native");

function verifiedLibrary(libraryPath, { sha256, architecture }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || "") || !["arm64", "x86_64"].includes(architecture)) throw new Error("An exact native Steam API checksum and architecture are required.");
  const file = Bundle.readRegular(libraryPath, 64 * 1024 * 1024);
  if (file.sha256 !== sha256) throw new Error("The native Steam API library changed.");
  const architectures = Native.readMachOArchitectures(libraryPath, { allowLibrary: true });
  if (!architectures.includes(architecture)) throw new Error(`The native Steam API library cannot run as ${architecture}.`);
  return { libraryPath, sha256, architectures };
}

module.exports = { verifiedLibrary };
