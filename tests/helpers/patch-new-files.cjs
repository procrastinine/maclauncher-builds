const fs = require("node:fs");

// The contents of the files a unified patch creates (`--- /dev/null`), by path.
function patchNewFiles(patchFile) {
  const lines = fs.readFileSync(patchFile, "utf8").split("\n"), files = {};
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "--- /dev/null" || !lines[i + 1]?.startsWith("+++ b/")) continue;
    const name = lines[i + 1].slice(6), hunk = /^@@ -0,0 \+1(?:,(\d+))? @@/.exec(lines[i + 2]);
    if (!hunk) throw new Error("Unexpected new-file hunk for " + name);
    const count = hunk[1] === undefined ? 1 : Number(hunk[1]), body = lines.slice(i + 3, i + 3 + count);
    if (body.some(line => !line.startsWith("+"))) throw new Error("Unexpected new-file line for " + name);
    files[name] = body.map(line => line.slice(1)).join("\n") + (lines[i + 3 + count] === "\\ No newline at end of file" ? "" : "\n");
    i += 2 + count;
  }
  return files;
}

module.exports = { patchNewFiles };
