const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Build = require("../producers/package-support/src/modules/shared/runtime/pinned-native-build.js");
// A fixture command ends once this test process is gone.
const untilTestEnds = `setInterval(()=>{try{process.kill(${process.pid},0)}catch{process.exit()}},200);`;
// The manager surface a Builds producer gives the builder: the selected catalog
// rows, an install directory, and the registration it records.
function listedManager({ id }, rows) {
  const registered = new Map(), core = {
    catalog: rows, normalizeVersion: value => value,
    getInstallDir: ({ userDataDir, version }) => path.join(userDataDir, "runtimes", id, version),
    resolveRegistered: ({ version }) => registered.get(version) || null,
    resolveInstalled: ({ version }) => registered.get(version) || null,
    registerLocal: input => { const record = { ...input, installDir: core.getInstallDir(input) }; registered.set(input.version, record); return record; }
  };
  return { id, core };
}

function git(root, args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-source-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.14)\nproject(fixture C)\n");
  fs.writeFileSync(path.join(source, ".gitignore"), "ignored.txt\n");
  git(source, ["add", "."]); git(source, ["commit", "-qm", "fixture"]);
  const revision = git(source, ["rev-parse", "HEAD"]);
  return { root, source, revision };
}

test("pinned source verification rejects dirty checkouts and stages tracked files only", async t => {
  const { root, source, revision } = fixture(t);
  const verified = await Build.validatePinnedSource(source, revision);
  fs.writeFileSync(path.join(source, "ignored.txt"), "untracked build input must stay out");
  const stage = path.join(root, "stage");
  const digest = Build.stagePinnedFiles(source, verified.files, stage);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(Build.hashPinnedFiles(source, [...verified.files].reverse()), digest);
  assert.equal(fs.readFileSync(path.join(stage, "CMakeLists.txt"), "utf8"), fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"));
  assert.equal(fs.existsSync(path.join(stage, ".git")), false);
  assert.equal(fs.existsSync(path.join(stage, "ignored.txt")), false);
  fs.appendFileSync(path.join(source, "CMakeLists.txt"), "# dirty\n");
  await assert.rejects(() => Build.validatePinnedSource(source, revision), /tracked changes/);
  assert.throws(() => Build.stagePinnedFiles(source, ["../outside"], path.join(root, "unsafe")), /Unsafe/);
  assert.throws(() => Build.hashPinnedFiles(source, ["../outside"]), /Unsafe/);
});

test("source staging rejects escaping symlinks", async t => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(root, "outside.h"), "fixture data");
  fs.symlinkSync("../outside.h", path.join(source, "header.h"));
  git(source, ["add", "header.h"]); git(source, ["commit", "-qm", "symlink"]);
  const verified = await Build.validatePinnedSource(source, git(source, ["rev-parse", "HEAD"]));
  assert.throws(() => Build.stagePinnedFiles(source, verified.files, path.join(root, "stage")), /symlink escapes/);
  assert.throws(() => Build.hashPinnedFiles(source, verified.files), /symlink escapes/);
});

test("source build isolates generator and module preparation writes, records both overlays and registers explicit version", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t);
  const userDataDir = path.join(root, "userdata");
  const manager = await listedManager({ id: "fixture-vn", label: "Fixture" }, [{ version: "1.0.0", upstreamRevision: revision }], userDataDir);
  // Resource availability must not prevent an explicit developer build from
  // registering its own exact-version artifact.
  const includedResolution = t.mock.method(manager.core, "resolveInstalled", () => ({ source: "bundled", readOnly: true, removable: false }));
  const overlay = path.join(root, "overlay.h"); fs.writeFileSync(overlay, "typedef unsigned char Byte;\n");
  const calls = [];
  const dependencies = { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "-S") {
      assert.equal(fs.existsSync(path.join(args[1], ".git")), false);
      assert.match(fs.readFileSync(path.join(args[1], "CMakeLists.txt"), "utf8"), /module-owned source overlay/);
      fs.writeFileSync(path.join(args[1], "generated-file.h"), "only the staged source can change");
      assert.ok(args.includes("-DFETCHCONTENT_FULLY_DISCONNECTED=ON"));
      assert.ok(args.includes("-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"));
      const cFlags = args.filter(arg => arg.startsWith("-DCMAKE_C_FLAGS="));
      assert.equal(cFlags.length, 1);
      assert.match(cFlags[0], /^-DCMAKE_C_FLAGS=-DFIXTURE_COMPILER=1 -ffile-prefix-map=/);
      assert.match(cFlags[0], / -include '/);
    } else {
      fs.mkdirSync(args[1], { recursive: true });
      const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4); binary.writeUInt32LE(2, 12);
      fs.writeFileSync(path.join(args[1], "runtime"), binary, { mode: 0o755 });
    }
  } };
  const installed = await Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    cmakeOptions: ["-DFIXTURE=ON", "-DCMAKE_C_FLAGS=-DFIXTURE_COMPILER=1 -ffile-prefix-map=/fixture=source"], overlay, prepareSource: ({ sourceRoot, revision: actual, version }) => {
      assert.equal(actual, revision); assert.equal(version, "1.0.0"); assert.notEqual(sourceRoot, source);
      fs.appendFileSync(path.join(sourceRoot, "CMakeLists.txt"), "# module-owned source overlay\n");
      return { revision: "fixture-overlay-v1", operations: ["source compatibility"] };
    }, resolveExecutable: dir => path.join(dir, "runtime"), dependencies });
  assert.equal(calls.length, 2); assert.equal(installed.version, "1.0.0");
  assert.equal(installed.verifiedBuild.sourceRevision, revision); assert.match(installed.verifiedBuild.overlaySha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.verifiedBuild.sourceOverlay.revision, "fixture-overlay-v1");
  assert.doesNotMatch(fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"), /module-owned source overlay/);
  assert.equal(fs.existsSync(path.join(source, "generated-file.h")), false);
  assert.equal(git(source, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(installed.installDir, "build.lock")), false);
  assert.equal(includedResolution.mock.callCount(), 0); includedResolution.mock.restore();
  assert.equal(manager.core.resolveRegistered({ userDataDir, version: "1.0.0" }).verifiedBuild.sourceRevision, revision);
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir, resolveExecutable: dir => path.join(dir, "runtime"), dependencies }), /already registered/);
});

test("cancellation in module source preparation runs no compiler and publishes no runtime", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t), userDataDir = path.join(root, "userdata");
  const controller = new AbortController(), manager = await listedManager({ id: "fixture-overlay-cancel", label: "Fixture" }, [{ version: "1.0.0", upstreamRevision: revision }], userDataDir);
  await assert.rejects(Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir, signal: controller.signal,
    prepareSource: () => { controller.abort(); return { revision: "cancelled-overlay" }; }, resolveExecutable: dir => path.join(dir, "runtime"),
    dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: () => { throw new Error("Compiler must not run"); } }
  }), error => error.name === "AbortError");
  const installDir = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(installDir, "runtime.json")), false);
  assert.equal(fs.existsSync(path.join(installDir, "build.lock")), false);
  assert.equal(git(source, ["status", "--porcelain"]), "");
});

test("canceling a native command stops its process and reports AbortError", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(Build.runBuildCommand(process.execPath, ["-e", untilTestEnds], {
      cwd: root, logPath: path.join(root, "build.log"), signal: controller.signal
    }), error => error.name === "AbortError");
  } finally { clearTimeout(timer); }
});

test("canceling source configure leaves no published runtime and releases its lock", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t), userDataDir = path.join(root, "userdata");
  const controller = new AbortController();
  const manager = await listedManager({ id: "fixture-canceled", label: "Fixture" }, [{ version: "1.0.0", upstreamRevision: revision }], userDataDir);
  let calls = 0;
  await assert.rejects(Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    signal: controller.signal, resolveExecutable: dir => path.join(dir, "runtime"),
    dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async () => { calls++; controller.abort(); } }
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
  const directory = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(directory, "runtime.json")), false);
  assert.equal(fs.existsSync(path.join(directory, "build.lock")), false);
  assert.equal(manager.core.resolveInstalled({ userDataDir, version: "1.0.0" }), null);
});

test("a native build timeout cannot succeed when the terminated child exits cleanly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(Build.runBuildCommand(process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); " + untilTestEnds],
    { cwd: root, logPath: path.join(root, "build.log"), timeout: 300 }), /timed out/);
});

test("failed source builds leave no runtime registration and release the build lock", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t); const userDataDir = path.join(root, "userdata");
  const manager = await listedManager({ id: "fixture-failed", label: "Fixture" }, [{ version: "1.0.0", upstreamRevision: revision }], userDataDir);
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    resolveExecutable: dir => path.join(dir, "runtime"), dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async () => { throw new Error("missing dependency"); } } }), /missing dependency/);
  const installDir = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(installDir, "runtime.json")), false); assert.equal(fs.existsSync(path.join(installDir, "build.lock")), false);
  assert.equal(manager.core.resolveInstalled({ userDataDir, version: "1.0.0" }), null);
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: installDir, userDataDir,
    resolveExecutable: dir => path.join(dir, "runtime") }), /separate directories/);
});

function scopeFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-primary-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child"), primary = path.join(root, "primary");
  const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  for (const directory of [child, primary]) {
    fs.mkdirSync(directory); git(directory, "init");
    git(directory, "config", "user.name", "Test Author"); git(directory, "config", "user.email", "test@example.invalid");
  }
  fs.writeFileSync(path.join(child, "unused.c"), "int unused(void) { return 1; }\n");
  git(child, "add", "."); git(child, "-c", "commit.gpgsign=false", "commit", "-m", "Child source");
  const childRevision = git(child, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(primary, "nested"));
  fs.writeFileSync(path.join(primary, "nested/main.c"), "int main(void) { return 0; }\n");
  fs.symlinkSync("nested/main.c", path.join(primary, "source-link.c"));
  const omittedPath = "third_party/unused";
  fs.writeFileSync(path.join(primary, ".gitmodules"), '[submodule "unused"]\n\tpath = third_party/unused\n\turl = ../child\n');
  git(primary, "add", ".");
  git(primary, "update-index", "--add", "--cacheinfo", `160000,${childRevision},${omittedPath}`);
  fs.mkdirSync(path.join(primary, omittedPath), { recursive: true });
  git(primary, "-c", "commit.gpgsign=false", "commit", "-m", "Primary source with unused child");
  const revision = git(primary, "rev-parse", "HEAD"), sourceScope = { kind: "primary-tree", omittedSubmodules: [omittedPath] };
  return { root, primary, child, git, revision, childRevision, omittedPath, sourceScope };
}

test("primary-tree scope verifies a real Git parent without fetching its unused child", async t => {
  const f = scopeFixture(t);
  await assert.rejects(Build.validatePinnedSource(f.primary, f.revision), /submodules are missing/);
  const source = await Build.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope });
  assert.deepEqual(source.omittedSubmodules, [{ path: f.omittedPath, revision: f.childRevision }]);
  assert.deepEqual(source.files.sort(), [".gitmodules", "nested/main.c", "source-link.c"]);
  const before = Build.hashPinnedFiles(f.primary, source.files), staged = path.join(f.root, "staged");
  assert.equal(Build.stagePinnedFiles(f.primary, source.files, staged), before);
  assert.equal(fs.readFileSync(path.join(staged, ".gitmodules"), "utf8"), fs.readFileSync(path.join(f.primary, ".gitmodules"), "utf8"));
  assert.equal(fs.readlinkSync(path.join(staged, "source-link.c")), "nested/main.c");
  assert.equal(fs.existsSync(path.join(staged, f.omittedPath)), false);
  assert.equal(f.git(f.primary, "status", "--porcelain=v1", "--ignore-submodules=all"), "");
  fs.writeFileSync(path.join(f.primary, f.omittedPath, "untracked-child.txt"), "Unused input\n");
  assert.equal(Build.hashPinnedFiles(f.primary, (await Build.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope })).files), before);
  fs.appendFileSync(path.join(f.primary, "nested/main.c"), "/* changed primary input */\n");
  assert.notEqual(Build.hashPinnedFiles(f.primary, source.files), before);
  await assert.rejects(Build.validatePinnedSource(f.primary, f.revision, { sourceScope: f.sourceScope }), /tracked changes/);
});

test("scopes reject unsafe shapes and missing, extra or unknown direct Gitlinks", async t => {
  const f = scopeFixture(t);
  for (const scope of [null, [], {}, { kind: "recursive", omittedSubmodules: [f.omittedPath] },
    { ...f.sourceScope, ignoredFiles: ["nested/main.c"] }, { ...f.sourceScope, omittedSubmodules: [] },
    { ...f.sourceScope, omittedSubmodules: [f.omittedPath, f.omittedPath] },
    ...["../escape", "/absolute", "C:/absolute", "a\\b", "a//b", "a/.git/b", "a\nb", "a\0b"].map(value => ({ ...f.sourceScope, omittedSubmodules: [value] }))]) {
    await assert.rejects(Build.validatePinnedSource(f.primary, f.revision, { sourceScope: scope }), /Primary source scopes/);
  }
  for (const omittedSubmodules of [["third_party/unknown"], [f.omittedPath, "third_party/extra"], ["third_party"]]) {
    await assert.rejects(Build.validatePinnedSource(f.primary, f.revision, { sourceScope: { ...f.sourceScope, omittedSubmodules } }), /every direct pinned Git submodule/);
  }
});

test("scoped source builds preserve the catalog scope and Gitlink descriptors in registration", { skip: process.platform !== "darwin" }, async t => {
  const f = scopeFixture(t), installDir = path.join(f.root, "install"); let registered;
  const manager = { id: "fixture", core: { catalog: [{ version: "1.0.0", upstreamRevision: f.revision, sourceScope: f.sourceScope }],
    normalizeVersion: value => value, getInstallDir: () => installDir, resolveInstalled: () => null,
    registerLocal: input => { registered = input; return { version: input.version }; } } };
  await Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: f.primary, userDataDir: f.root,
    resolveExecutable: root => path.join(root, "fixture"), dependencies: { findBuildTool: () => "/usr/bin/true", runBuildCommand: async () => {} } });
  assert.deepEqual(registered.verifiedBuild.sourceScope, f.sourceScope);
  assert.deepEqual(registered.verifiedBuild.omittedSubmodules, [{ path: f.omittedPath, revision: f.childRevision }]);
  assert.equal(registered.verifiedBuild.sourceTreeSha256, Build.hashPinnedFiles(f.primary, [".gitmodules", "nested/main.c", "source-link.c"]));
});
