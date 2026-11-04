const { gitlink } = require("../../../../../../../lib/pins.mjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = gitlink("producers/maclauncher/src/external/OpenGMK");
const OVERLAY_VERSION = "maclauncher-appkit-gl-6";
const SOURCE_FILES = ["Cargo.toml", "gm8emulator/Cargo.toml", "gm8emulator/build.rs", "gm8emulator/src/main.rs", "gm8emulator/src/render/opengl.rs", "gm8emulator/src/game.rs", "gm8emulator/src/gml/file.rs", "gm8emulator/src/game/includedfile.rs", "gm8emulator/src/game/external.rs", "gm8emulator/src/gml/kernel.rs"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function applyEmulatorOverlay({ sourceDir, ramenDir, soundioDir }) {
  for (const value of [sourceDir, ramenDir, soundioDir]) if (!path.isAbsolute(value || "")) throw Error("OpenGMK overlay paths must be absolute.");
  const source = fs.realpathSync(sourceDir);
  const external = path.resolve(__dirname, "../../../../external/OpenGMK");
  if (source === external || fs.existsSync(external) && source === fs.realpathSync(external)) throw Error("OpenGMK vendored source is read-only; use an owned source copy.");
  const inputs = {};
  for (const file of SOURCE_FILES) {
    const location = path.join(source, file), stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw Error(`OpenGMK ${REVISION} identity check failed for ${file}; no source was patched.`);
    }
    inputs[file] = fs.readFileSync(location, "utf8");
  }
  const ramen = JSON.parse(fs.readFileSync(path.join(ramenDir, "maclauncher-overlay.json"), "utf8"));
  if (ramen.upstreamRevision !== require("./apply-ramen").REVISION || ramen.backend !== "AppKit") throw Error("The pinned AppKit ramen overlay is required.");
  const audioManifest = JSON.parse(fs.readFileSync(path.join(soundioDir, "maclauncher-overlay.json"), "utf8"));
  if (audioManifest.upstreamRevision !== require("./apply-audio").REVISION || audioManifest.backend !== "CoreAudio") throw Error("The pinned CoreAudio build overlay is required.");
  inputs["Cargo.toml"] += `\n[patch."https://github.com/viriuwu/ramen"]\nramen = { path = ${JSON.stringify(ramenDir)} }\n\n[patch."https://github.com/Adamcake/udon"]\nlibsoundio-sys = { path = ${JSON.stringify(soundioDir)} }\n`;
  inputs["gm8emulator/Cargo.toml"] = inputs["gm8emulator/Cargo.toml"].replace('[dependencies]\n', '[dependencies]\nserde_json = "=1.0.149"\nlewton = "=0.10.2"\n');
  inputs["gm8emulator/Cargo.toml"] += '\n[target.\'cfg(target_os = "macos")\'.build-dependencies]\ncc = "=1.2.60"\n';
  inputs["gm8emulator/build.rs"] = inputs["gm8emulator/build.rs"].replace("    Ok(())\n}", `    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/render/opengl/macos.m")
            .flag("-Wno-deprecated-declarations").compile("maclauncher_opengmk_gl");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=OpenGL");
        println!("cargo:rerun-if-changed=src/render/opengl/macos.m");
    }
    Ok(())\n}`);
  inputs["gm8emulator/src/render/opengl.rs"] = inputs["gm8emulator/src/render/opengl.rs"]
    .replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]')
    .replace("fb_current == self.framebuffer.fbo as _", "fb_current == self.framebuffer.fbo as gl::types::GLint") + '\n#[cfg(target_os = "macos")]\nmod macos;\n#[cfg(target_os = "macos")]\nuse macos as native_gl;\n';
  inputs["gm8emulator/src/game.rs"] = inputs["gm8emulator/src/game.rs"].replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]');
  // Upstream's TAS-only dummy effect bypass is inappropriate for normal Mac
  // gameplay. Every actual DLL definition must reach the native ABI guard.
  inputs["gm8emulator/src/game/external.rs"] = inputs["gm8emulator/src/game/external.rs"]
    .replace('        if dll.eq_ignore_ascii_case("gmeffect_0.1.dll") {', '        if self.dummy_audio && dll.eq_ignore_ascii_case("gmeffect_0.1.dll") {');
  inputs["gm8emulator/src/main.rs"] = inputs["gm8emulator/src/main.rs"]
    .replace("mod action;", "mod maclauncher_inspect;\nmod action;")
    .replace('    opts.optflag("h", "help", "prints this help message");', '    opts.optflag("h", "help", "prints this help message");\n    opts.optflag("", "inspect-json", "parse assets and report extension ABI without running GML");\n    opts.optflag("", "version", "prints the exact MacLauncher source and overlay identity");')
    .replace('    if args.len() < 2 || matches.opt_present("h") {', `    if matches.opt_present("version") {
        println!("OpenGMK 0.2.0 MacLauncher ${REVISION} ${OVERLAY_VERSION}");
        return EXIT_SUCCESS;
    }
    if args.len() < 2 || matches.opt_present("h") {`)
    .replace("    let absolute_path = match file_path.canonicalize() {", `    if matches.opt_present("inspect-json") {
        return match maclauncher_inspect::print_report(&assets) {
            Ok(()) => EXIT_SUCCESS,
            Err(error) => { eprintln!("Asset inspection failed: {}", error); EXIT_FAILURE }
        };
    }

    let absolute_path = match file_path.canonicalize() {`);
  inputs["gm8emulator/src/gml/kernel.rs"] = inputs["gm8emulator/src/gml/kernel.rs"]
    .replace("            #[cfg(unix)]\n            {\n                self.window.xid()\n            }", '            #[cfg(target_os = "linux")]\n            {\n                self.window.xid()\n            }\n            #[cfg(target_os = "macos")]\n            {\n                self.window.nswindow() as usize as f64\n            }');
  inputs["gm8emulator/src/game/external.rs"] = inputs["gm8emulator/src/game/external.rs"]
    .replace("mod wow64;", '#[cfg(not(target_os = "macos"))]\nmod wow64;\n#[cfg(target_os = "macos")]\nmod macos;')
    .replace('#[cfg(not(all(target_os = "windows", target_arch = "x86")))]\nuse wow64 as ipc;', '#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86"))))]\nuse wow64 as ipc;\n#[cfg(target_os = "macos")]\nuse macos as ipc;');
  inputs["gm8emulator/src/game/external.rs"] += '\npub fn native_extension_profiles() -> serde_json::Value {\n    #[cfg(target_os = "macos")] { macos::extension_profiles() }\n    #[cfg(not(target_os = "macos"))] { serde_json::json!([]) }\n}\n';
  require("./apply-paths").applyPathOverlay(inputs);
  require("./apply-highscore").applyHighscoreOverlay(inputs);
  require("./apply-window").applyWindowOverlay(inputs);
  for (const [file, content] of Object.entries(inputs)) fs.writeFileSync(path.join(source, file), content);
  const copies = { "macos.rs": "gm8emulator/src/render/opengl/macos.rs", "macos.m": "gm8emulator/src/render/opengl/macos.m", "external.rs": "gm8emulator/src/game/external/macos.rs", "inspect.rs": "gm8emulator/src/maclauncher_inspect.rs", "paths.rs": "gm8emulator/src/maclauncher_paths.rs", "highscore.rs": "gm8emulator/src/maclauncher_highscore.rs", "window.rs": "gm8emulator/src/maclauncher_window.rs", "supersound.rs": "gm8emulator/src/game/external/macos/supersound.rs" };
  const overlayHashes = {};
  for (const [file, destination] of Object.entries(copies)) {
    const bytes = fs.readFileSync(path.join(__dirname, "renderer", file));
    fs.mkdirSync(path.dirname(path.join(source, destination)), { recursive: true });
    fs.writeFileSync(path.join(source, destination), bytes);
    overlayHashes[file] = digest(bytes);
  }
  const record = { schemaVersion: 1, upstreamRevision: REVISION, overlayVersion: OVERLAY_VERSION,
    sourceHashes: Object.fromEntries(SOURCE_FILES.map(file=>[file,digest(fs.readFileSync(path.join(source,file)))])), overlayHashes, ramen, audio: audioManifest, buildDependency: "cc=1.2.60",
    backend: "AppKit/OpenGL4.1/CoreAudio", windowsExtensionHost: "disabled", nativeExtensionProfiles: ["supersound-string-abi-v1"], externalFilesModified: false };
  fs.writeFileSync(path.join(source, "maclauncher-overlay.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

module.exports = { REVISION, OVERLAY_VERSION, SOURCE_FILES, applyEmulatorOverlay };
