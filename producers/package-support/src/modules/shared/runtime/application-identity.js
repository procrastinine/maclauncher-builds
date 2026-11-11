const fs = require("node:fs"), path = require("node:path");
// Attach only to an exported build tree. The helper is part of the executable,
// with no runtime payload or per-game file of its own.
function attach(directory, target, cmake = "CMakeLists.txt") {
  if (!path.isAbsolute(directory) || fs.existsSync(path.join(directory, ".git")) || !/^[A-Za-z0-9_-]+$/.test(target))
    throw new Error("Native identity requires an owned source export and target.");
  const file = path.join(directory, cmake), name = "maclauncher-application-identity.m";
  let text = fs.readFileSync(file, "utf8");
  if (text.includes(name)) throw new Error("Native identity was already attached.");
  fs.copyFileSync(path.join(__dirname, "application-identity.m"), path.join(path.dirname(file), name));
  text += '\nif(APPLE AND TARGET ' + target + ')\n  enable_language(OBJC)\n  target_sources(' + target + ' PRIVATE "' + name + '")\n  set_source_files_properties("' + name + '" PROPERTIES COMPILE_OPTIONS "-fobjc-arc;-fblocks")\n  target_link_options(' + target + ' PRIVATE "SHELL:-framework AppKit")\nendif()\n';
  fs.writeFileSync(file, text);
}
module.exports = { attach };
