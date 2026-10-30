const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Portable = require("../producers/maclauncher/src/modules/alicesoft/system35-portable-v3");
const Overlay = require("../producers/maclauncher/src/modules/alicesoft/system35-overlay-v3");
const Prefix = require("../producers/maclauncher/src/modules/shared/runtime/portable-dependency-prefix");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-system35-portable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

function copyInputs(t) {
  if (!fs.existsSync(path.join(Portable.sourcePath, "src/font.c"))) { t.skip("xsystem35 source submodule is not initialized"); return null; }
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(path.join(source, "src"), { recursive: true });
  for (const relative of Object.keys(Overlay.SOURCE_HASHES)) fs.copyFileSync(path.join(Portable.sourcePath, relative), path.join(source, relative));
  return { root, source };
}

test("portable xsystem35 adapters keep upstream files unchanged and make dependency choices explicit", t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const originals = Object.keys(Overlay.SOURCE_HASHES).map(relative => fs.readFileSync(path.join(Portable.sourcePath, relative)));
  const result = Overlay.apply(fixture.source);
  assert.equal(result.files.length, 2);
  const cmake = fs.readFileSync(path.join(fixture.source, "CMakeLists.txt"), "utf8");
  assert.match(cmake, /elseif \(ENABLE_PORTMIDI\)\n    find_library/);
  assert.match(cmake, /if \(ENABLE_GETTEXT AND/);
  assert.match(cmake, /if \(APPLE\)\n      set\(DEFAULT_FONT_PATH ""\)/);
  assert.match(fs.readFileSync(path.join(fixture.source, "src/font.c"), "utf8"), /_NSGetExecutablePath/);
  Object.keys(Overlay.SOURCE_HASHES).forEach((relative, i) => assert.deepEqual(fs.readFileSync(path.join(Portable.sourcePath, relative)), originals[i]));
  assert.throws(() => Overlay.apply(Portable.sourcePath), /separate writable/);
  assert.throws(() => Overlay.adapt("src/font.c", Buffer.from("another version")), /checksum/);
});

test("adapter source validation finishes before writing either file and rejects escaped links", t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const cmake = fs.readFileSync(path.join(fixture.source, "CMakeLists.txt"));
  fs.writeFileSync(path.join(fixture.source, "src/font.c"), "changed input");
  assert.throws(() => Overlay.apply(fixture.source), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.source, "CMakeLists.txt")), cmake);
  fs.unlinkSync(path.join(fixture.source, "src/font.c")); fs.symlinkSync(path.join(Portable.sourcePath, "src/font.c"), path.join(fixture.source, "src/font.c"));
  assert.throws(() => Overlay.apply(fixture.source), /contained regular/);
});

test("native default fonts resolve beside a relocated executable and preserve custom paths", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const source = Overlay.adapt("src/font.c", fs.readFileSync(path.join(Portable.sourcePath, "src/font.c"))).toString("utf8");
  const start = source.indexOf("static FT_Face open_default_font("), end = source.indexOf("\n#endif\n\nstatic FT_Face open_face", start);
  assert.ok(start > 0 && end > start);
  const runtime = path.join(fixture.root, "Runtime With Spaces.app/Contents/Resources/engines/files"), executable = path.join(runtime, "bin/probe");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(path.join(runtime, "share/xsystem35/fonts"), { recursive: true });
  for (const name of ["MTLc3m.ttf", "mincho.ttf"]) fs.writeFileSync(path.join(runtime, "share/xsystem35/fonts", name), "font fixture");
  const header = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdint.h>\n#include <limits.h>\n#include <mach-o/dyld.h>\n#define DEFAULT_GOTHIC_TTF "MTLc3m.ttf"\n#define DEFAULT_MINCHO_TTF "mincho.ttf"\ntypedef void* FT_Face; static void* ft_library; static int FT_New_Face(void* lib,const char* file,int index,FT_Face* face) { (void)lib;(void)index;FILE* f=fopen(file,"rb");if(!f)return 1;fclose(f);*face=(void*)1;return 0; }\n';
  const main = '\nint main(void) { if(!open_default_font(DEFAULT_GOTHIC_TTF,0)||!open_default_font(DEFAULT_MINCHO_TTF,0))return 1; if(open_default_font("custom.ttf",0))return 2;return 0; }\n';
  const file = path.join(fixture.root, "probe.c"); fs.writeFileSync(file, header + source.slice(start, end) + main);
  execFileSync("/usr/bin/clang", ["-arch", "arm64", "-mmacosx-version-min=13.0", file, "-o", executable], { timeout: 30000, stdio: "pipe" });
  execFileSync(executable, [], { cwd: os.tmpdir(), timeout: 10000, stdio: "pipe" });
  const alias = path.join(fixture.root, "runtime-alias"); fs.symlinkSync(executable, alias);
  execFileSync(alias, [], { cwd: os.tmpdir(), timeout: 10000, stdio: "pipe" });
});

test("dependency prefix checksums reject external links, content mutations and recipe mismatches", t => {
  const root = temporary(t), prefix = path.join(root, "prefix"); fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
  fs.writeFileSync(path.join(prefix, "lib/library"), "dependency content"); fs.symlinkSync("library", path.join(prefix, "lib/alias"));
  const inventory = Prefix.snapshotPrefix(prefix), pin = { id: "fixture", version: "1", archiveSha256: "a".repeat(64), options: [] };
  const catalog = { version: "fixture-v1", architecture: "arm64", minimumMacOS: "13.0", dependencies: [pin] }, stack = { version: catalog.version, architecture: "arm64", minimumMacOS: "13.0",
    recipeSha256: "b".repeat(64), prefix, prefixSha256: inventory.sha256, sources: [pin] };
  assert.equal(Prefix.validateStack(stack, catalog, stack.recipeSha256, "arm64").sha256, inventory.sha256);
  assert.throws(() => Prefix.validateStack({ ...stack, recipeSha256: "c".repeat(64) }, catalog, stack.recipeSha256, "arm64"), /exact source recipe/);
  assert.throws(() => Prefix.validateStack({ ...stack, sources: [{ ...pin, version: "2" }] }, catalog, stack.recipeSha256, "arm64"), /source identity/);
  assert.throws(()=>Prefix.validateStack(stack,catalog,stack.recipeSha256,"x64"),/exact source recipe/);
  fs.writeFileSync(path.join(prefix, "lib/library"), "changed dependency");
  assert.throws(() => Prefix.validateStack(stack, catalog, stack.recipeSha256, "arm64"), /prefix checksum/);
  const outside = path.join(root, "outside"); fs.writeFileSync(outside, "outside"); fs.symlinkSync(outside, path.join(prefix, "lib/escaped"));
  assert.throws(() => Prefix.snapshotPrefix(prefix), /inside their declared prefixes/);
});

test("read-only dependency views link only build inputs and refuse conflicting files", t => {
  const root = temporary(t), input = path.join(root, "input"), output = path.join(root, "output");
  fs.mkdirSync(path.join(input, "lib/pkgconfig"), { recursive: true }); fs.mkdirSync(path.join(input, "bin")); fs.mkdirSync(output);
  fs.writeFileSync(path.join(input, "lib/dependency"), "content"); fs.writeFileSync(path.join(input, "lib/pkgconfig/example.pc"), "pkg"); fs.writeFileSync(path.join(input, "bin/other-runtime"), "unrelated");
  const before = Prefix.snapshotPrefix(input);
  Prefix.linkPrefix(input, output);
  assert.equal(fs.lstatSync(path.join(output, "lib/dependency")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(output, "bin/other-runtime")), false);
  assert.equal(Prefix.snapshotPrefix(input).sha256, before.sha256);
  assert.throws(() => Prefix.linkPrefix(input, input), /separate build prefix/);
  fs.unlinkSync(path.join(output, "lib/dependency")); fs.writeFileSync(path.join(output, "lib/dependency"), "collision");
  assert.throws(() => Prefix.linkPrefix(input, output), /conflicting files/);
});

test("cancelled portable builds make no output or source changes", async t => {
  const root = temporary(t), controller = new AbortController(); controller.abort();
  const workRoot = path.join(root, "output");
  await assert.rejects(Portable.buildPortableSystem35({ workRoot, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(workRoot), false);
  assert.match(Portable.overlayIdentity(), /^[a-f0-9]{64}$/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(require.resolve("../producers/maclauncher/src/modules/alicesoft/system35-overlay-v3"))).digest("hex").length, 64);
});
