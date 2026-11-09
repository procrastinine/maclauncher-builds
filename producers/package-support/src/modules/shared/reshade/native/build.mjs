import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import {moduleFile,recipePath} from '../../../../../../../tools/app-source.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = import.meta.dirname;
const [sourceArg, buildArg, outputArg, option] = process.argv.slice(2);
if (!sourceArg || !buildArg || !outputArg || (option && option !== "--compiler-only") || process.argv.length > 6)
  throw new Error("Usage: node build.mjs <base source> <existing universal build> <output directory> [--compiler-only]\n" +
    "Create the base source with materialize-source.mjs <directory> --base-only and the universal build with\n" +
    "node scripts/build-graphics-runtime.mjs --only core --work <directory> (its core/build directory).");
const compilerOnly = option === "--compiler-only";
const source = path.resolve(sourceArg), build = path.resolve(buildArg), output = path.resolve(outputArg);
const libraSource = path.resolve(process.env.MACLAUNCHER_LIBRASHADER_SOURCE || path.join(root, "../../../../external/librashader"));
const libraHeader = path.join(libraSource, "include/librashader.h");
const overlay = JSON.parse(fs.readFileSync(path.join(root, "source-overlay.json"), "utf8"));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hash = file => digest(fs.readFileSync(file));
const owned = ["CMakeLists.txt", "README.md", ...["src", "compat"].flatMap(dir =>
  fs.readdirSync(path.join(source, dir), { recursive: true }).map(name => path.join(dir, name))
    .filter(name => fs.statSync(path.join(source, name)).isFile()))].sort();
const sourceHash = digest(Buffer.concat(owned.map(name => Buffer.concat([Buffer.from(name + "\0"), fs.readFileSync(path.join(source, name))]))));
if (fs.existsSync(output)) throw new Error("Use a new output directory.");
const applied = path.join(output, "source");
fs.mkdirSync(applied, { recursive: true });
addLicenses(applied,"ReShade",source);
for (const name of [...owned, ".gitmodules"]) {
  const target = path.join(applied, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, name), target);
}
for (const entry of overlay.files) {
  fs.mkdirSync(path.dirname(path.join(applied, entry.path)), { recursive: true });
  fs.copyFileSync(recipePath(root, entry.source), path.join(applied, entry.path));
}
const companions=["retroarch-source.json","build-retroarch.mjs","retroarch-prepare/Cargo.toml","retroarch-prepare/Cargo.lock","retroarch-prepare/main.rs"];
for(const relative of companions) {
  const target=path.join(applied,"src",relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(moduleFile("src/modules/shared/reshade/native/"+relative),target);
}

const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_|KLEPTON_|KL_)/.test(key)) delete env[key];
const run = (command, args) => execFileSync(command, args, { cwd: output, env, encoding: "utf8", timeout: 120000, maxBuffer: Infinity});
const tokenize = line => (line.match(/"[^"]*"|[^\s]+/g) || [])
  .map(token => token.startsWith('"') ? token.slice(1, -1) : token);
const recipe = path.join(build, "CMakeFiles/reshade-macos.dir/link.txt");
const recipes = [], reused = [];
function linkRecipe(name) {
  const file = path.join(build, "CMakeFiles", name + ".dir/link.txt");
  recipes.push({ path: file, sha256: hash(file) });
  const tokens = tokenize(fs.readFileSync(file, "utf8").trim());
  if (tokens.shift() !== "/usr/bin/c++" || tokens.some(token => /reexport/.test(token)))
    throw new Error("Unsupported native link recipe: " + name);
  return tokens;
}
const tokens = linkRecipe("reshade-macos");
const overlayUnits = overlay.files.filter(entry => /^src\/[^/]+\.(mm|cpp)$/.test(entry.path) && entry.path !== "src/compile.cpp" &&
  (entry.nativeLink || entry.path === "src/temporal.mm" || tokens.some(token => token.endsWith("/" + path.basename(entry.path) + ".o"))))
  .map(entry => path.basename(entry.path));
// Overlay headers can change layouts used by otherwise unchanged host units.
// Recompile this small directly linked host, keeping vendor archives reusable.
const linkedUnits = tokens.flatMap(token => {
  const match = /^CMakeFiles\/reshade-macos\.dir\/src\/([^/]+\.(?:mm|cpp))\.o$/.exec(token);
  return match ? [match[1]] : [];
});
const changed = [...new Set([...linkedUnits, ...overlayUnits])];
const addedObjects = changed.filter(name => !tokens.some(token => token.endsWith("/" + name + ".o"))).map(name => path.join(output, name + ".o"));
const recordReused = token => {
  const file = path.resolve(build, token);
  reused.push({ path: file, sha256: hash(file) });
  return file;
};
const mapLink = (tokens, native = false) => tokens.map(token => {
  if (!token.endsWith(".o") && !token.endsWith(".a")) return token;
  if (path.basename(token) === "libreshadefx.a") return path.join(output, "libreshadefx.a");
  if (native && path.basename(token) === "libreshade-diagnostics.a") return path.join(output, "libreshade-diagnostics.a");
  if (token.endsWith("/src/compile.cpp.o")) return path.join(output, "compile.cpp.o");
  if (native && changed.some(name => token.endsWith("/" + name + ".o"))) return path.join(output, path.basename(token));
  return recordReused(token);
});
// Rebuild the two changed compiler units and every directly linked host unit.
// Unchanged compiler objects and vendor archives remain the original inputs.
const flags = ["-O3", "-DNDEBUG", "-std=gnu++17", "-arch", "arm64", "-arch", "x86_64",
  "-mmacosx-version-min=13.0", "-fPIC", "-Wno-deprecated-declarations",
  "-Werror=unguarded-availability", "-Dreshade_macos_EXPORTS", "-I" + path.join(applied, "src"),
  "-I" + path.join(source, "third_party/reshade/source")];
flags.push("-I" + path.dirname(libraHeader));
// The existing build may come from the base tree or from a complete
// materialized tree. Owned include directories always resolve to the newly
// applied source; pinned vendor directories resolve to the base source.
const buildSource = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(fs.readFileSync(path.join(build, "CMakeCache.txt"), "utf8"))?.[1] || source;
function recipeIncludes(target, language) {
  const file = path.join(build, "CMakeFiles", target + ".dir/flags.make");
  recipes.push({path: file, sha256: hash(file)});
  const includesLine = new RegExp("^" + language + "_INCLUDES = (.*)$", "m").exec(fs.readFileSync(file, "utf8"));
  if (!includesLine) throw new Error("Missing include recipe: " + target);
  return tokenize(includesLine[1]).map(token => {
    if (!token.startsWith("-I") || !path.isAbsolute(token.slice(2))) throw new Error("Unsupported include recipe: " + target);
    const relative = path.relative(buildSource, token.slice(2));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return token;
    return "-I" + path.join(/^(src|compat)(\/|$)/.test(relative) ? applied : source, relative);
  });
}
const nativeIncludes = compilerOnly ? [] : recipeIncludes("reshade-macos", "OBJCXX");
const compilerFlags = [...flags, "-I" + path.join(applied, "compat"),
  "-I" + path.join(source, "third_party/reshade/deps/spirv/include"),
  "-I" + path.join(source, "third_party/spirv-cross")];
const compilerSources = ["src/effect.cpp", "compat/effect_preprocessor.cpp"];
for (const name of compilerSources) run("/usr/bin/c++", [...compilerFlags,
  "-c", path.join(applied, name), "-o", path.join(output, path.basename(name) + ".o")]);
const archiveRecipe = path.join(build, "CMakeFiles/reshadefx.dir/link.txt");
recipes.push({ path: archiveRecipe, sha256: hash(archiveRecipe) });
const archiveTokens = tokenize(fs.readFileSync(archiveRecipe, "utf8").split("\n")[0]);
if (archiveTokens[0] !== "/usr/bin/ar" || archiveTokens[1] !== "qc" || archiveTokens[2] !== "libreshadefx.a" ||
    archiveTokens.slice(3).some(token => !token.endsWith(".o"))) throw new Error("Unsupported compiler archive recipe.");
const objects = archiveTokens.slice(3).map(token => {
  const name = path.basename(token);
  if (compilerSources.some(source => path.basename(source) + ".o" === name)) {
    return path.join(output, name);
  }
  return recordReused(token);
});
run("/usr/bin/libtool", ["-static", "-o", path.join(output, "libreshadefx.a"), ...objects]);
// Shader metadata is shared with the command-line consumer. Recompile that
// small consumer whenever applying an overlay, rather than mixing layouts.
run("/usr/bin/c++", [...flags, ...recipeIncludes("fx-compile", "CXX"), "-c", path.join(applied, "src/compile.cpp"), "-o", path.join(output, "compile.cpp.o")]);
run("/usr/bin/c++", mapLink(linkRecipe("fx-compile")));
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", path.join(output, "fx-compile")]);
if (!compilerOnly) {
// Diagnostics is an owned host component in a separate archive. Its public
// header and implementation must come from the same applied source tree too.
run("/usr/bin/c++", [...flags, "-c", path.join(applied, "src/diagnostics.cpp"), "-o", path.join(output, "diagnostics.cpp.o")]);
run("/usr/bin/libtool", ["-static", "-o", path.join(output, "libreshade-diagnostics.a"), path.join(output, "diagnostics.cpp.o")]);
for (const name of changed) run("/usr/bin/c++", [...flags, ...nativeIncludes,
  ...(name === "lsfg.mm" ? ["-std=c++20"] : []), ...(name === "opengl.mm" || name.endsWith(".cpp") ? [] : ["-fobjc-arc"]),
  "-c", path.join(applied, "src", name), "-o", path.join(output, name + ".o")]);
run("/usr/bin/c++", [...mapLink(tokens, true), ...addedObjects, "-framework", "ImageIO", "-framework", "CoreGraphics",
  "-framework", "CoreMedia", "-weak_framework", "ScreenCaptureKit"]);
fs.copyFileSync(path.join(build, "libvkd3d-shader.dylib"), path.join(output, "libvkd3d-shader.dylib"));
const library = path.join(output, "libreshade-macos.dylib");
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", library]);
// Same arm64 selector-stub form as the CMake targets (see CMakeLists.txt).
run("/usr/bin/c++", ["-O3", "-std=c++17", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0", "-fobjc-arc", "-Wno-deprecated-declarations", "-Werror=unguarded-availability-new",
  "-Wl,-objc_stubs_small", path.join(applied,"src/graphics-video.mm"), "-o", path.join(output,"maclauncher-graphics-video"),
  ...["Foundation","AVFoundation","CoreVideo","CoreMedia","CoreGraphics","VideoToolbox","Metal"].flatMap(name=>["-framework",name])]);
run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", path.join(output,"maclauncher-graphics-video")]);
}
const selected = overlay.files.map(entry => ({ path: entry.path, sha256: hash(path.join(applied, entry.path)) }));
const library = path.join(output, "libreshade-macos.dylib");
fs.writeFileSync(path.join(output, "build-receipt.json"), JSON.stringify({ schema: 1, baseSourceHash: sourceHash,
  companions: companions.map(relative => ({ path: "src/"+relative, sha256: hash(path.join(applied,"src",relative)) })),
  externalHeaders: [{ path: libraHeader, sha256: hash(libraHeader) }],
  selected, reused, recipes, compilerOnly, linkRecipeSha256: hash(recipe),
  compilerSha256: hash(path.join(output, "fx-compile")), compilerArchiveSha256: hash(path.join(output, "libreshadefx.a")),
  ...(compilerOnly ? {} : { librarySha256: hash(library), diagnosticsArchiveSha256: hash(path.join(output, "libreshade-diagnostics.a")) }) }, null, 2) + "\n");
console.log(JSON.stringify({ output, ownedSource: applied, compilerOnly,
  rebuilt: compilerSources.length + 1 + (compilerOnly ? 0 : changed.length + 1), reused: reused.length }));
