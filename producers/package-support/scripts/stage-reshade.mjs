import {appPath,appRequire,moduleFile,moduleFiles} from '../../../tools/app-source.mjs';
import sharedDependencies from '../../dependencies.json' with {type:'json'};
import dependencies from '../../../producers/dependencies.json' with {type:'json'};
const {shaderc}=dependencies;
import {gitlink,sourceRevision} from '../../../lib/pins.mjs';
import {addLicense,addLicenses,includeLicenses} from '../../../lib/licenses.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const Native=appRequire('src/modules/shared/runtime/local-native.js');
const Content=appRequire('scripts/runtime-content.cjs');
import { productionOwnedFiles } from "./stage-reshade-source.mjs";
import {stageTemporalProvider} from "./stage-temporal-provider.mjs";
import {stageNativeImageFilters} from "./stage-native-image-filters.mjs";
import {stageFSR4Provider} from "./stage-fsr4-provider.mjs";
const {SCENE_SHADER_INPUTS}=appRequire('src/modules/shared/effects/operation-contracts.mjs');
import {stageLibplaceboScene} from "./stage-libplacebo-scene.mjs";
import {stageStreamlineSnapshots} from "./stage-streamline-snapshots.mjs";
import {ALIAS_INDEX,aliasIndex,deduplicate,resolvedPrefixes} from "./payload-aliases.mjs";
const features = JSON.parse(fs.readFileSync(appPath("src/modules/shared/reshade/features.json"), "utf8"));
const effectSources = JSON.parse(fs.readFileSync(appPath("src/modules/shared/reshade/effect-sources.json"), "utf8"));

const args = process.argv.slice(2), source = args.shift();
if (!source) throw new Error("A ReShade macOS source directory is required.");
const build = path.resolve(source, args[0] && !args[0].startsWith("--") ? args.shift() : "build-physical");
const options = {};
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!["--version", "--arch", "--output", "--declaration", "--source-root", "--owned-source", "--spirv-cross-source", "--isf", "--xess-host", "--xess-host-source", "--fsr", "--fsr4", "--fsr4-source", "--asr", "--asr-source", "--sgsr2", "--sgsr2-source", "--fsr3-generation", "--godot", "--streamline", "--dxmt", "--xess", "--retroarch", "--libplacebo", "--neural"].includes(key) || !value || value.startsWith("--") || options[key])
    throw new Error("Usage: node scripts/stage-reshade.mjs <source> [build] [--owned-source <source>] [--spirv-cross-source <checkout>] [--isf <payload>] [--xess-host <payload>] [--xess-host-source <source>] [--fsr <payload>] [--fsr4 <payload>] [--fsr4-source <checkout>] [--asr <payload>] [--asr-source <checkout>] [--sgsr2 <payload>] [--sgsr2-source <checkout>] [--fsr3-generation <payload>] [--godot <payload>] [--streamline <payload>] [--dxmt <payload>] [--xess <payload>] [--retroarch <payload>] [--libplacebo <payload>] [--neural <payload>]");
  options[key] = ["--version","--arch"].includes(key) ? value : path.resolve(value);
}
const upstreamRoot=options["--source-root"]||path.resolve(import.meta.dirname,"..");
const xessSource=path.resolve(upstreamRoot,"src/external/xess");
const packageArch=options["--arch"]||"universal";
if(!["arm64","x64","universal"].includes(packageArch))throw Error("Choose arm64, x64 or universal graphics.");
const packageCPUs=packageArch==="universal"?["arm64","x86_64"]:[packageArch==="x64"?"x86_64":"arm64"];
if(!options["--version"]||!options["--output"]||!options["--declaration"])throw Error("Staging requires --version, --output and --declaration.");
if(options["--xess-host-source"]&&!options["--xess-host"])throw Error("An owned XeSS source snapshot requires its exact GPU host payload.");
// Owned adaptations may be built outside the read-only pinned checkout. Vendor
// revisions and license sources still come from that original checkout.
const ownedSource = options["--owned-source"] || source;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const owned = productionOwnedFiles(ownedSource);
const sourcePolicy = [path.resolve(import.meta.dirname, "stage-reshade-source.mjs"), appPath("src/modules/shared/runtime/production-source.js"), appPath("src/modules/shared/runtime/runtime-content.js")]
  .map(file => fs.readFileSync(file));
let sourceHash = digest(Buffer.concat([Buffer.from("production-source-v1\0"), ...sourcePolicy,
  ...owned.map(name => Buffer.concat([Buffer.from(name + "\0"), fs.readFileSync(path.join(ownedSource, name))]))]));
const registeredSources = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  "../src/modules/shared/reshade/native/processor-sources.json"), "utf8"));
const pins = registeredSources.sources.map(entry => {
  const directory = entry.id === "macfx-spirv-cross" && options["--spirv-cross-source"] || path.resolve(upstreamRoot, entry.submodulePath);
  const actual = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  return ` ${actual} ${entry.sourcePath}`;
});
const nativeFiles = ["libreshade-macos.dylib", "libvkd3d-shader.dylib", "fx-compile"];
if(fs.existsSync(path.join(build,"shaderc-offline")))nativeFiles.push("shaderc-offline");
if(fs.existsSync(path.join(build,"maclauncher-graphics-video"))) nativeFiles.push("maclauncher-graphics-video");
if(features.graphics.windowSourceAPI===2){
  nativeFiles.push("maclauncher-graphics-window");
}
if(features.graphics.hardwareQueryAPI===1){
  nativeFiles.push("maclauncher-graphics-hardware");
}
const retroarchInputs = new Map();
const extraSources=[];
const optionalInputs=new Map(),optionalLoad=new Map(),extraOwned=new Map();
if(options["--xess-host"]){
  const directory=options["--xess-host"],module="src/modules/shared/reshade/xess",metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  const generation=metadata.generation;
  const owned=metadata.source.ownedFiles.map(row=>row.path);
  const backends=metadata.backends,hostPaths=metadata.hostPaths;
  if(metadata.schema!==1||metadata.providerABI!==1||!Array.isArray(metadata.files)||!Array.isArray(metadata.source?.ownedFiles))throw Error("A complete compatible original XeSS GPU host is required.");
  const nativeSource=options["--xess-host-source"];
  for(const name of owned){const file=nativeSource?path.resolve(nativeSource,name):moduleFile(path.posix.join(module,"native",name));extraOwned.set("maclauncher/xess/native/"+name,file);}
  extraOwned.set("maclauncher/xess/source.json",moduleFile(module+"/source.json"));
  if(generation)extraOwned.set("maclauncher/xess/components.json",moduleFile(module+"/components.json"));
  const actual=execFileSync("git",["-C",xessSource,"rev-parse","HEAD"],{encoding:"utf8"}).trim();pins.push(` ${actual} third_party/xess-original`);
  if(backends.includes("vulkan")){
    const headers=JSON.parse(fs.readFileSync(moduleFile(module+"/native/vulkan-source.json")));
    for(const row of headers.headers){
      const file=path.join(directory,"source/vulkan",row.path);
      extraOwned.set("maclauncher/xess/native/vulkan/"+row.path,file);
    }
    pins.push(` ${sourceRevision(sharedDependencies.sdlHeaders)} third_party/xess-vulkan-headers`);
  }else if(metadata.source.vulkanHeaders)throw Error("The XeSS Vulkan source is declared without its GPU host.");
  for(const row of metadata.files){if(typeof row.path!=="string"||path.isAbsolute(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==="."||part===".."))throw Error("The XeSS GPU host contains an undeclared resource.");const file=path.join(directory,row.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid XeSS GPU host resource: "+row.path);if(!row.path.startsWith("source/"))optionalInputs.set("xess/"+row.path,file);if(row.path.endsWith(".so"))optionalLoad.set("xess/"+row.path,{architectures:["x86_64"],minimumMacOS:metadata.minimumMacOS});}
  optionalInputs.set("xess/provider.json",path.join(directory,"provider.json"));features.graphics.xessSceneAPI=1;
}
if(options["--isf"]){
  const directory=options["--isf"],module="src/modules/shared/reshade/isf",source=JSON.parse(fs.readFileSync(moduleFile(module+"/source.json"))),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  if(!Array.isArray(metadata.files)||!metadata.owned)throw Error("A complete compatible ISF provider is required.");
  const ownedNames=Object.keys(metadata.owned);
  const isfFile=name=>moduleFile(path.posix.join(module,name));
  for(const entry of source.sources){
    const upstream=path.resolve(upstreamRoot,entry.path),actual=execFileSync("git",["-C",upstream,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    pins.push(` ${actual} third_party/isf/${path.basename(entry.path)}`);
  }
  for(const row of metadata.files){
    if(typeof row.path!=="string"||path.isAbsolute(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==="."||part===".."))throw Error("The ISF provider contains an undeclared or duplicate resource.");
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid ISF provider resource: "+row.path);
    optionalInputs.set("isf/"+row.path,file);if(row.path.endsWith(".dylib"))optionalLoad.set("isf/"+row.path,{architectures:source.architectures,minimumMacOS:source.minimumMacOS});
  }
  optionalInputs.set("isf/provider.json",path.join(directory,"provider.json"));
  for(const name of ownedNames)extraOwned.set(path.posix.normalize("maclauncher/isf/"+name),isfFile(name));
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"isf"])];features.shaders.providers??={};features.shaders.providers.isf={nodeABI:1,architectures:packageCPUs.filter(cpu=>metadata.architectures.includes(cpu)),minimumMacOS:metadata.minimumMacOS};
  if(metadata.sceneInputsAPI!==undefined){
    const roles=SCENE_SHADER_INPUTS.filter(name=>!["viewMatrix","projectionMatrix"].includes(name));
    Object.assign(features.shaders.providers.isf,{sceneInputsAPI:1,sceneInputRoles:[...roles]});
  }
}
if (options["--neural"]) {
  const neuralModule = "src/modules/shared/reshade/neural", neuralFile = relative => moduleFile(neuralModule + "/" + relative);
  const directory = options["--neural"], source = JSON.parse(fs.readFileSync(neuralFile("source.json"), "utf8"));
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
  if(descriptor.providerABI!==source.providerABI||!Array.isArray(descriptor.files))throw Error("A compatible neural rendering provider is required.");
  if(descriptor.estimatedDepthAPI===1){
    features.graphics.estimatedDepthAPI=1;
  }
  if(descriptor.gpuTimingAPI===1)features.graphics.neuralGpuTimingAPI=1;
  for (const entry of descriptor.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid neural provider path.");
    const file = path.join(directory, entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid neural provider resource: "+entry.path);
    const relative = "neural/" + entry.path;
    optionalInputs.set(relative, file);
    if (/\.(dylib|so)$/.test(entry.path) || ["maclauncher-neural-video","maclauncher-neural-service"].includes(entry.path)) optionalLoad.set(relative, {architectures: ["arm64"], minimumMacOS: entry.path === "maclauncher-neural-video" ? "26.0" : source.minimumMacOS});
  }
  if(descriptor.restorationAPI===1&&descriptor.operations?.includes("rife"))features.graphics.videoFrameGenerationMethods=[...new Set([...(features.graphics.videoFrameGenerationMethods||[]),"rife"])];
  optionalInputs.set("neural/provider.json", path.join(directory, "provider.json"));
  const upstream = path.resolve(upstreamRoot, "src/external/MLX-DLSS");
  const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const relative of ["source.json", "build.mjs", "native/build.sh", "native/prepare-upstream.mjs",...(descriptor.gpuTimingAPI===1?["native/prepare-mlx-timing.mjs"]:[]), "native/Package.swift",
    "native/Package.resolved", "native/upstream.json",...(descriptor.gpuTimingAPI===1?moduleFiles(neuralModule+"/native/timing").map(name=>"native/timing/"+name):[]),...(descriptor.estimatedDepthAPI===1?["native/depth-anything-source.json"]:[]),...(descriptor.restorationAPI===1?["native/restoration-sources.json","native/rife-v4.6.param"]:[]), ...moduleFiles(neuralModule + "/native/Sources").map(name => "native/Sources/" + name)]) {
    extraOwned.set("maclauncher/neural/" + relative, neuralFile(relative));
  }
  extraOwned.set("maclauncher/neural/adaptation.json", path.join(directory, "adaptation.json"));
  if(descriptor.gpuTimingAPI===1)extraOwned.set("maclauncher/neural/timing-adaptation.json",path.join(directory,"timing-adaptation.json"));
  extraSources.push({ directory: upstream, relative: "third_party/MLX-DLSS", commit: revision,
    scope: ["Package.swift", "Package.resolved", "Sources/DLSSCore", "Sources/DLSSMLX", "Sources/DLSSMedia"] });
  pins.push(` ${revision} third_party/MLX-DLSS`);
}
const processorSources=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/processor-sources.json");
extraOwned.set("maclauncher/native/processor-sources.json",processorSources);
let libplacebo;
if(options["--libplacebo"]) {
  const directory=options["--libplacebo"];
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  features.shaders??={};features.shaders.providers??={};features.shaders.providers.libplacebo={...features.shaders.providers.libplacebo,architectures:packageCPUs.filter(cpu=>metadata.architectures.includes(cpu)),minimumMacOS:metadata.minimumMacOS};
  for(const entry of metadata.files) {
    if(typeof entry.path!=="string"||path.isAbsolute(entry.path)||entry.path.split(/[\\/]/).some(part=>!part||part==="."||part===".."))throw new Error("Invalid optional provider path.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid provider resource: "+entry.path);
    optionalInputs.set(entry.path,file);
    if(/\.(dylib|so)$/.test(entry.path)||entry.path===metadata.helper)optionalLoad.set(entry.path,{architectures:metadata.architectures,minimumMacOS:metadata.minimumMacOS});
  }
  const scene=stageLibplaceboScene({directory,metadata,recipeRoot:path.resolve(import.meta.dirname,"../src/modules/shared/reshade"),upstream:path.resolve(upstreamRoot,"src/external/libplacebo")});
  if(scene){
    features.shaders.providers??={};features.shaders.providers.libplacebo={...features.shaders.providers.libplacebo,sceneInputsAPI:1,sceneInputRoles:scene.roles};
    pins.push(...scene.pins);for(const [relative,file]of scene.owned)extraOwned.set(relative,file);
  }
  if(features.shaders.providers?.libplacebo?.imageFiltersAPI===1){
  }
  optionalInputs.set("libplacebo/provider.json",path.join(directory,"provider.json"));
  for(const [relative,name] of [
    ["maclauncher/libplacebo-build.mjs","libplacebo-build.mjs"],
    ["maclauncher/compiler-isolation.mjs","compiler-isolation.mjs"],
    ...["libplacebo-node.hpp","libplacebo-node.mm","libplacebo-prepare.mm","image-budget.hpp","test/libplacebo-node.mm"].map(name=>["maclauncher/native/"+name,"native/"+name])
  ])if(!Content.excludedReason(relative))extraOwned.set(relative,moduleFile("src/modules/shared/reshade/"+name));
  libplacebo=metadata;
}
if(options["--retroarch"]) {
  const directory=options["--retroarch"];
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,"runtime-files.json"),"utf8"));
  if(!Array.isArray(manifest.files))throw new Error("A complete RetroArch shader payload is required.");
  for(const entry of manifest.files) {
    if(typeof entry.path!=="string"||path.isAbsolute(entry.path)||entry.path.split(/[\\/]/).some(part=>!part||part==="."||part===".."))throw Error("The RetroArch shader payload contains an undeclared or duplicate resource.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid provider resource: "+entry.path);
    retroarchInputs.set(entry.path,file);
  }
  const original=path.resolve(upstreamRoot,"src/external/librashader");
  const actual=execFileSync("git",["-C",original,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  extraSources.push({directory:original,relative:"third_party/librashader",commit:actual});
  pins.push(` ${actual} third_party/librashader`);
  nativeFiles.push("librashader.dylib","retroarch-prepare");
  if(manifest.sceneInputsAPI!==undefined){
    const names=Object.keys(manifest.ownedSource);
    for(const name of names)extraOwned.set("maclauncher/native/"+name,moduleFile(path.posix.join("src/modules/shared/reshade/native",name)));
    extraOwned.set("effects/operation-contracts.mjs",appPath("src/modules/shared/effects/operation-contracts.mjs"));
    features.shaders.providers??={};
    for(const format of ["slangp","slang"])features.shaders.providers[format]={...features.shaders.providers[format],sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]};
  }
}
const temporalInputs = new Map();
const temporalExecutionArchitectures = new Map();
if(options["--fsr4-source"]&&!options["--fsr4"])throw Error("An FSR 4 source checkout requires its provider payload.");
if(options["--fsr3-generation"]){
  const directory=options["--fsr3-generation"];
  for(const relative of fs.readdirSync(directory,{recursive:true}).sort()){
    const file=path.join(directory,relative),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error("Generation payloads require regular files and directories.");
    if(stat.isDirectory())continue;
    temporalInputs.set("generation/fsr3/"+relative,file);
  }
  for(const name of ["source.json","build.mjs","backend.mm","metal-backend.hpp","index.js"])extraOwned.set("maclauncher/generation/fsr3/"+name,moduleFile("src/modules/shared/reshade/generation/fsr3/"+name));
  pins.push(` ${gitlink("producers/package-support/src/external/fsr3-sdk")} third_party/FidelityFX-SDK-generation`);
  features.graphics.generationProviderAPI=1;features.graphics.frameGenerationMethods=[...new Set([...(features.graphics.frameGenerationMethods||[]),"fsr3"])];
}
if(options["--xess"]){
  const directory=options["--xess"],metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  const xessModule="src/modules/crossover/temporal/xess",xessFile=relative=>moduleFile(path.posix.join(xessModule,relative));
  const source=JSON.parse(fs.readFileSync(xessFile("source.json"),"utf8"));
  for(const [id,submodule]of [["xess","xess"],["dxmt","dxmt-camera"]]){
    const root=path.resolve(upstreamRoot,"src/external",submodule),commit=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    pins.push(` ${commit} third_party/${submodule}`);
  }
  for(const name of Object.keys(metadata.owned))extraOwned.set("maclauncher/crossover/temporal/xess/"+name,xessFile(name));
  const dependencies={
    "dxmt/camera-transport.hpp":"../dxmt/camera-transport.hpp",
    "temporal/camera.h":"../../../shared/reshade/temporal/camera.h",
    "temporal/frame.h":"../../../shared/reshade/temporal/frame.h"
  };
  for(const [name,relative]of Object.entries(dependencies)){
    const file=xessFile(relative);
    const ownedName=name.startsWith("dxmt/")?"maclauncher/crossover/temporal/"+name:"maclauncher/shared/reshade/"+name;
    extraOwned.set(ownedName,file);
  }
  for(const name of [source.library,"provider.json"])temporalInputs.set("temporal/xess/"+name,path.join(directory,name));
}
for (const name of ["fsr", "fsr4"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  if(name==="fsr4"){
    const staged=stageFSR4Provider({directory,upstream:options["--fsr4-source"]});
    features.graphics.temporalProfiles={...features.graphics.temporalProfiles,fsr4:staged.profiles};
      for(const [relative,file]of staged.files)temporalInputs.set(relative,file);
      for(const [relative,file]of staged.owned)extraOwned.set(relative,file);
      extraSources.push(staged.source);pins.push(...staged.pins);
      features.graphics.temporalProfileAPI=1;continue;
  }
  for (const relative of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Temporal payloads must contain regular files.");
    if (stat.isFile()) temporalInputs.set(`temporal/${name}/${relative}`, file);
  }
}
for(const name of ["asr","sgsr2"]){
  const directory=options["--"+name];if(!directory){if(options["--"+name+"-source"])throw Error("A temporal source checkout requires its provider payload.");continue;}
  const staged=stageTemporalProvider({name,directory,upstream:options["--"+name+"-source"]});
  for(const [relative,file] of staged.files)temporalInputs.set(relative,file);
  for(const [relative,file] of staged.owned)extraOwned.set(relative,file);
  extraSources.push(staged.source);pins.push(staged.pin);
  features.graphics.temporalMethods=[...new Set([...(features.graphics.temporalMethods||[]),name])];
  features.graphics.temporalProviderRegistryAPI=1;
}
const snapshotProviders=new Set();
for (const name of ["godot", "streamline", "dxmt"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, name === "dxmt" ? "camera-bridge.json" : "provider.json")));
  if(name === "streamline" && metadata.cameraBridge){
    if(metadata.cameraBridge.architecture!=="x86_64")throw Error("Unsupported temporal camera host architecture");
    temporalExecutionArchitectures.set("temporal/streamline/"+metadata.cameraBridge.unix,metadata.cameraBridge.architecture);
  }
  const selected = name === "godot" ? ["libmaclauncher-godot-camera.dylib", "provider.json", "autoload.gd", "camera-effect.gd"]
    : name === "streamline" ? ["sl.interposer.dll", "provider.json", ...(metadata.profiles||[]).map(row=>path.posix.join(row.directory,row.library)), ...(metadata.cameraBridge?[metadata.cameraBridge.windows,metadata.cameraBridge.unix]:[])]
    : [...Object.keys(metadata.files).filter(name=>name!=="source.tar.gz"), "camera-bridge.json"];
  if (name === "godot" ? metadata.abi !== 1 || metadata.complete !== true : metadata.schema !== 1)
    throw new Error("Unsupported camera bridge metadata.");
  if(name!=="godot"){
    const snapshots=stageStreamlineSnapshots({name,directory,metadata});
    if(snapshots){snapshotProviders.add(name);pins.push(snapshots.pin);for(const [relative,file]of snapshots.owned)extraOwned.set(relative,file);}
  }
  if(name==="godot"&&metadata.sceneAovAPI!==undefined){
    const programs=metadata.aovCapture?.programs,godotFile=relative=>moduleFile(path.posix.join("src/modules/godot/graphics",relative));
    const sourceNames=Object.keys(metadata.ownedSourceSha256);
    for(const relative of sourceNames){const file=godotFile(relative);extraOwned.set(path.posix.normalize("maclauncher/godot/graphics/"+relative),file);}
    for(const file of ["build.mjs","source.json"])extraOwned.set("maclauncher/godot/graphics/"+file,godotFile(file));
    selected.push("aov-effect.gd",...programs.map(row=>row.file));
  }
  for (const relative of selected) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid camera bridge path.");
    const file = path.join(directory, relative);
    if (!fs.lstatSync(file).isFile()) throw new Error("Camera bridges must contain regular files.");
    temporalInputs.set(`${name === "godot" ? "godot" : "temporal/" + name}/${relative}`, file);
  }
}
if(snapshotProviders.size){
  features.graphics.streamlineSnapshotAPI=1;
}
const nativePaths = new Map(nativeFiles.map(file => [file, path.join(build, file)]));
for(const [relative,file] of retroarchInputs)if(nativeFiles.includes(relative))nativePaths.set(relative,file);
for(const relative of optionalLoad.keys()){nativeFiles.push(relative);nativePaths.set(relative,optionalInputs.get(relative));}
if(nativeFiles.includes("maclauncher-graphics-video")) optionalLoad.set("maclauncher-graphics-video", {architectures: ["arm64", "x86_64"], minimumMacOS: "14.0"});
if(nativeFiles.includes("maclauncher-graphics-window")) optionalLoad.set("maclauncher-graphics-window", {architectures: ["arm64", "x86_64"], minimumMacOS: "15.2"});
for (const [relative, file] of temporalInputs) if (/\.(dylib|so)$/.test(relative)) {
 nativeFiles.push(relative);nativePaths.set(relative,file);
 const architectures=Native.readMachOArchitectures(file,{allowLibrary:true}),floors=[...execFileSync("xcrun",["vtool","-show-build",file],{encoding:"utf8"}).matchAll(/minos\s+(\d+(?:\.\d+)+)/g)].map(match=>match[1]);
 // DXMT runs in its separate Intel host; it is not loaded into the launcher.
 if(!relative.startsWith("temporal/dxmt/")&&!temporalExecutionArchitectures.has(relative))optionalLoad.set(relative,{architectures,minimumMacOS:["13.0",...floors].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1)});
}
const nativeArchitectures = new Map();
for (const file of nativeFiles) {
  const architectures = Native.readMachOArchitectures(nativePaths.get(file), { allowLibrary: /\.(dylib|so)$/.test(file) });
  nativeArchitectures.set(file, architectures);
}
const symbols = execFileSync("/usr/bin/nm", ["-gU", path.join(build, "libreshade-macos.dylib")], { encoding: "utf8" });
const buildSDKs=[...execFileSync("xcrun",["vtool","-show-build",path.join(build,"libreshade-macos.dylib")],{encoding:"utf8"}).matchAll(/sdk\s+(\d+(?:\.\d+)+)/g)].map(match=>match[1]);
const buildSDK=buildSDKs.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
const metalFx27Inputs=buildSDK.localeCompare("27.0",undefined,{numeric:true})>=0;
if(metalFx27Inputs)features.graphics.metalFX27InputsAPI=1;else delete features.graphics.metalFX27InputsAPI;
features.graphics.requirements={...(features.graphics.requirements||{}),metalFX27Inputs:{minimumMacOS:"27.0"}};
if(/\b_rsShaderLinearInputPolicyAPI\b/.test(symbols))features.shaders.linearInputPolicyAPI=1;
if(/\b_rsShaderSceneHistoryAPI\b/.test(symbols)){
  features.shaders.sceneHistoryAPI=1;features.shaders.providers??={};
  features.shaders.providers.fx={...features.shaders.providers.fx,sceneHistoryAPI:1};
}
if(/\b_rsMetal4SceneAPI\b/.test(symbols)){
  features.graphics.metal4SceneAPI=1;
}
if(/\b_rsShaderSceneInputsAPI\b/.test(symbols)){
  Object.assign(features.graphics,{sceneAovAPI:1,sceneCopyBoundaryAPI:1,shaderSceneInputsAPI:1});
  features.shaders.sceneInputsAPI=features.graphics.shaderSceneInputsAPI;
  features.shaders.providers??={};
  for(const format of ["fx"])
    features.shaders.providers[format]={...features.shaders.providers[format],sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]};
  extraOwned.set("maclauncher/native/scene-role-header.mjs",path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/scene-role-header.mjs"));
  extraOwned.set("effects/operation-contracts.mjs",appPath("src/modules/shared/effects/operation-contracts.mjs"));
}
if(/\b_rsMetalFxDenoisedAPI\b/.test(symbols)){
  features.graphics.metalFXDenoisedAPI=1;
  features.graphics.temporalMethods=[...new Set([...(features.graphics.temporalMethods||[]),"metalfx-denoised"])];
}
const nativeImageFilters=stageNativeImageFilters({ownedSource,symbols});
if(nativeImageFilters){
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"native"])];features.shaders.providers??={};
  features.shaders.providers.native={architectures:["arm64","x86_64"],minimumMacOS:"13.0",methods:nativeImageFilters.methods};
  pins.push(...nativeImageFilters.pins);
  for(const [relative,file]of nativeImageFilters.owned)extraOwned.set(relative,file);
}
if(nativeFiles.includes("shaderc-offline")&&optionalInputs.has("libplacebo/libshaderc_shared.1.dylib")&&symbols.includes("makeMagpieShaderNode")){
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"magpie"])];features.shaders.providers??={};
  features.shaders.providers.magpie={...features.shaders.providers.magpie,architectures:["arm64","x86_64"],minimumMacOS:"13.0",compilerMinimumMacOSByArchitecture:Object.fromEntries(packageCPUs.map(cpu=>[cpu,libplacebo.minimumMacOS]))};
  if(features.graphics.shaderSceneInputsAPI===1)Object.assign(features.shaders.providers.magpie,{sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]});
}
if(extraOwned.size)sourceHash=digest(Buffer.concat([Buffer.from(sourceHash+'\0'),...[...extraOwned].flatMap(([relative,file])=>[Buffer.from(relative+'\0'),fs.readFileSync(file)])]));
// The optional DXMT bridge has the selected Windows runtime's own macOS floor.
const floors = nativeFiles.filter(file => !file.startsWith("temporal/dxmt/")&&!optionalLoad.has(file)).flatMap(file =>
  [...execFileSync("xcrun", ["vtool", "-show-build", nativePaths.get(file)], { encoding: "utf8" }).matchAll(/minos\s+(\d+(?:\.\d+)+)/g)].map(match => match[1]));
const minimumMacOS = floors.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const inputs = new Map([
  ...nativePaths,
  ...retroarchInputs,
  ...optionalInputs,
  ...temporalInputs,

]);
if(nativeFiles.includes("shaderc-offline"))pins.push(` ${shaderc.revision} third_party/shaderc-headers`);
if(fs.existsSync(path.join(ownedSource,"src/color-source.json"))){
  const colorSource=JSON.parse(fs.readFileSync(path.join(ownedSource,"src/color-source.json"),"utf8"));
  pins.push(` ${sourceRevision(colorSource)} third_party/Khronos-ToneMapping`);
}
for (const name of ["ReShade.fxh", "ReShadeUI.fxh"]) inputs.set("include/" + name, path.join(source, "third_party/reshade-shaders/Shaders", name));
const effects = appPath("src/modules/shared/reshade/effects");
for (const name of fs.readdirSync(effects)) inputs.set("effects/" + name, path.join(effects, name));
// Identical files under the paths providers open through the shared payload
// resolver are stored once; each provider's alias index names the stored copy
// of every removed path.
const deduplicated = deduplicate(inputs, { prefixes: resolvedPrefixes(inputs), keep: new Set(nativeFiles) });
const removedPayload = new Set([...inputs.keys()].filter(relative => !deduplicated.inputs.has(relative)));
for (const relative of removedPayload) inputs.delete(relative);
const aliasIndexes = [...deduplicated.indexes].map(([directory, aliases]) => [path.posix.join(directory, ALIAS_INDEX), Buffer.from(aliasIndex(aliases))]);
if (aliasIndexes.some(([relative]) => inputs.has(relative))) throw new Error("A provider payload cannot supply its own alias index.");
const version = options["--version"];
const directoryRelative = `reshade/${version}/${packageArch}`;
const destination = options["--output"];
if(fs.existsSync(destination))throw Error("Use a new graphics output directory.");
fs.mkdirSync(destination, { recursive: true });
for (const directory of ["include", "effects"]) fs.mkdirSync(path.join(destination, directory), { recursive: true });
addLicenses(destination,"ReShade",source);
if(options["--xess-host"]){addLicenses(destination,"Intel-XeSS",xessSource);addLicense(destination,"Intel-XeSS headers",path.join(xessSource,"inc/MIT.txt"));addLicense(destination,"Intel-XeSS dependencies",path.join(xessSource,"third-party-programs.txt"));}
for(const option of ["--godot","--streamline","--dxmt"])if(options[option])includeLicenses(destination,`${options[option]}/licenses`);
addLicenses(destination,"native filters",path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native"));
addLicense(destination,"MacShade",path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/licenses/macshade-BSD.txt"),"MacShade-BSD-3-Clause");
addLicense(destination,"MetalDuck",path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/licenses/metalduck-MIT.txt"),"MetalDuck-MIT");
const files = [];
for (const [relative, input] of inputs) {
  const output = path.join(destination, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const executable = nativeFiles.includes(relative);
  if(executable&&packageArch!=="universal"&&nativeArchitectures.get(relative)?.length>1){
    execFileSync("/usr/bin/lipo",[input,"-thin",packageCPUs[0],"-output",output]);nativeArchitectures.set(relative,[packageCPUs[0]]);
  }else fs.copyFileSync(input, output, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(output, executable ? 0o755 : 0o644);
  if (executable) execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", output], { stdio: "pipe" });
  files.push({ path: relative, sha256: digest(fs.readFileSync(output)), size: fs.statSync(output).size,
    mode: executable ? 0o755 : 0o644, ...(executable ? { architectures: nativeArchitectures.get(relative),
      ...(relative.startsWith("temporal/dxmt/") ? { executionArchitecture: "x86_64" } : temporalExecutionArchitectures.has(relative) ? { executionArchitecture: temporalExecutionArchitectures.get(relative) } : {}),
      ...(optionalLoad.has(relative)?{optionalLoad:{...optionalLoad.get(relative),architectures:nativeArchitectures.get(relative)}}:{}) } : {}) });
}
// The camera provider's source is available in the tagged producer repository.
if(options["--xess-host"]){
  const relative="xess/provider.json",file=path.join(destination,relative),metadata=JSON.parse(fs.readFileSync(file));
  metadata.files=metadata.files.filter(row=>!row.path.startsWith("source/")).map(row=>{const actual=files.find(item=>item.path==="xess/"+row.path);return {...row,size:actual.size,sha256:actual.sha256};});
  fs.writeFileSync(file,JSON.stringify(metadata,null,2)+"\n");Object.assign(files.find(row=>row.path===relative),{sha256:digest(fs.readFileSync(file)),size:fs.statSync(file).size});
}
if (inputs.has('temporal/dxmt/camera-bridge.json')) {
  const relative='temporal/dxmt/camera-bridge.json',file=path.join(destination,relative),metadata=JSON.parse(fs.readFileSync(file));
  delete metadata.files['source.tar.gz'];fs.writeFileSync(file,JSON.stringify(metadata,null,2)+'\n');
  Object.assign(files.find(entry=>entry.path===relative),{sha256:digest(fs.readFileSync(file)),size:fs.statSync(file).size});
}
// CPU thinning changes provider inventories as well as their native bytes.
// Refresh nested descriptor entries from the final copies, deepest paths first.
if(packageArch!=="universal"){
 const jsonFiles=files.filter(row=>row.path.endsWith(".json")).sort((a,b)=>b.path.split("/").length-a.path.split("/").length);
 for(const entry of jsonFiles){
  const file=path.join(destination,entry.path);let metadata;try{metadata=JSON.parse(fs.readFileSync(file));}catch{continue;}
  let changed=false;
  if(Array.isArray(metadata.architectures)&&metadata.architectures.includes(packageCPUs[0])){metadata.architectures=[packageCPUs[0]];changed=true;}
  if(Array.isArray(metadata.files))for(const row of metadata.files){
   if(typeof row.path!=="string"||row.path.split("/").includes("..")||path.isAbsolute(row.path))continue;
   const base=entry.path==="libplacebo/provider.json"?destination:path.dirname(file),target=path.join(base,row.path),relative=path.relative(destination,target).split(path.sep).join("/"),actual=files.find(value=>value.path===relative);
   if(actual){Object.assign(row,{size:fs.statSync(target).size,sha256:digest(fs.readFileSync(target)),...(actual.architectures?{architectures:actual.architectures}:{})});changed=true;}
  }
  if(changed)fs.writeFileSync(file,JSON.stringify(metadata,null,2)+"\n");
 }
 for(const row of files){const file=path.join(destination,row.path);Object.assign(row,{size:fs.statSync(file).size,sha256:digest(fs.readFileSync(file))});}
}
// Source and owned build recipes are delivered by the tagged producer repository.
function record(relative) {
  const file = path.join(destination, relative); fs.chmodSync(file, 0o644);
  return { path: relative, sha256: digest(fs.readFileSync(file)), size: fs.statSync(file).size, mode: 0o644 };
}
if(packageArch!=="universal")for(const specification of Object.values(features.shaders?.providers||{}))
 if(Array.isArray(specification.architectures))specification.architectures=specification.architectures.filter(cpu=>packageCPUs.includes(cpu));
for (const [relative, bytes] of aliasIndexes) { fs.writeFileSync(path.join(destination, relative), bytes); files.push(record(relative)); }
for(const relative of fs.readdirSync(destination,{recursive:true}))if(fs.statSync(path.join(destination,relative)).isFile()&&!files.some(row=>row.path===relative))files.push(record(relative));
fs.writeFileSync(path.join(destination, "runtime.json"), JSON.stringify({ schema: 1, version,
  minimumMacOS, build:{sdkVersion:buildSDK}, architectures: packageCPUs, features, effectSources, sourceHash, sourcePins: pins.map(line => line.trim()), files }, null, 2) + "\n");
const manifest = record("runtime.json"); files.push(manifest);
const declaration = { id: "reshade", version, arch: packageArch, launcherArchitectures: packageArch==="universal"?["arm64","x64"]:[packageArch], minimumMacOS,
  sourceRelative: null, sourceSha256: sourceHash, directoryRelative,
  manifestRelative: manifest.path, manifestSha256: manifest.sha256, files};
const selectedDeclaration=options["--declaration"], declarationTemporary=selectedDeclaration+"."+crypto.randomBytes(8).toString("hex")+".tmp";
try{
 fs.writeFileSync(declarationTemporary,JSON.stringify(declaration,null,2)+"\n",{flag:"wx",mode:0o644});fs.renameSync(declarationTemporary,selectedDeclaration);
}finally{fs.rmSync(declarationTemporary,{force:true});}
console.log(JSON.stringify({ destination, version, minimumMacOS, files: files.length, sourceHash }));
