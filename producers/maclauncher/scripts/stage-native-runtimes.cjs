// Native library inspection shared by the standalone producer recipes.
const { execFileSync } = require("node:child_process");
const B = require("../src/modules/shared/runtime/bundled-native");
const run = (command,args) => execFileSync(command,args,{encoding:"utf8",timeout:60000,maxBuffer:16*1024*1024});

function loadCommands(file, architecture) {
  const text = run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-l", file]);
  const minima = [...text.matchAll(/cmd LC_BUILD_VERSION[^]*?minos\s+(\d+\.\d+(?:\.\d+)?)/g),
    ...text.matchAll(/cmd LC_VERSION_MIN_MACOSX[^]*?version\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  if (!minima.length) throw new Error(`Missing macOS deployment target: ${file}`);
  const rpaths = [...text.matchAll(/cmd LC_RPATH\n[^]*?\n\s*path ([^\n]+) \(offset \d+\)/g)].map(match => match[1]);
  return { minimumMacOS: minima.sort((a, b) => B.versionAtLeast(a, b) ? -1 : 1)[0], rpaths };
}

function parseLinkedLibraries(output) {
  // Universal binaries have a separate unindented filename/architecture header
  // for each slice. Only indented compatibility records are dependency names.
  return [...new Set(String(output).split("\n").flatMap(line => {
    const match = /^\s+(.+?) \(compatibility version[^]*$/.exec(line);
    return match ? [match[1]] : [];
  }))];
}

function links(file, architecture) {
  return parseLinkedLibraries(run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-L", file]));
}

function libraryIds(file, architecture) {
  return run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-D", file]).split("\n").map(line => line.trim()).filter(line => line && !line.endsWith(":"));
}


module.exports = { loadCommands, parseLinkedLibraries, links, libraryIds };
