import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import {sourceRevision} from '../../../../../scripts/graphics-source-revision.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {verifyTimingReceipt} from './native/prepare-mlx-timing.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../../../..");
const source = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const restorationArchitectures=createRequire(import.meta.url)('./restoration-models.js').ARCHITECTURES;

const cacheDirectory = path.join(os.homedir(), "Library", "Caches", "maclauncher", "neural-provider");

export function buildProvider({ output = path.join(cacheDirectory, "output"),
  sourceDirectory = path.join(repository, "src/external/MLX-DLSS"),
  buildRoot = path.join(cacheDirectory, "build"),
  cacheRoot = path.join(cacheDirectory, "swiftpm") } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("The neural rendering provider build requires Apple Silicon macOS.");
  sourceDirectory = fs.realpathSync(sourceDirectory);
  const revision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== sourceRevision(source)) throw new Error("The neural rendering source does not match its registered revision.");
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  // SwiftPM writes dependency edits and lock fingerprints beside Package.swift.
  // Keep the public producer and the pinned app source immutable by building an
  // owned source projection of copied files, never links back to either.
  const recipeRoot=path.resolve(buildRoot+"-recipe"),shared=path.resolve(directory,"../.."),stagedShared=path.join(recipeRoot,"src/modules/shared");
  if(recipeRoot.startsWith(repository+path.sep)||repository.startsWith(recipeRoot+path.sep))throw Error("Neural work must be separate from the producer checkout.");
  const Content=createRequire(import.meta.url)("../../runtime/runtime-content.js");
  fs.mkdirSync(stagedShared,{recursive:true});
  fs.cpSync(path.join(shared,"reshade"),path.join(stagedShared,"reshade"),{recursive:true,dereference:true,filter:file=>{const relative=path.relative(shared,file);return !relative.split(path.sep).includes("Packages")&&!Content.excludedReason(relative);}});
  execFileSync("/bin/bash", [path.join(stagedShared,"reshade/neural/native/build.sh"), output], {
    cwd: repository, stdio: "inherit", env: { ...process.env,
      MACLAUNCHER_BUILD_DOWNLOAD: path.resolve(repository, "../../tools/download.mjs"),
      MACLAUNCHER_NEURAL_PREPARE_UPSTREAM: path.join(directory, "native/prepare-upstream.mjs"),
      MACLAUNCHER_MLX_DLSS_SOURCE: sourceDirectory,
      MACLAUNCHER_NEURAL_BUILD_ROOT: path.resolve(buildRoot),
      MACLAUNCHER_NEURAL_CACHE_ROOT: path.resolve(cacheRoot) },
  });
  addLicenses(output,'MLX-DLSS',sourceDirectory);
  addLicenses(output,'MLX-Swift',path.join(buildRoot,'owned-source/mlx-swift'));
  addLicenses(output,'MLX',path.join(buildRoot,'owned-source/mlx-swift/Source/Cmlx/mlx'));
  addLicenses(output,'Swift Argument Parser',path.join(buildRoot,'checkouts/swift-argument-parser'));
  addLicenses(output,'Swift Numerics',path.join(buildRoot,'checkouts/swift-numerics'));
  addLicenses(output,'neural models',path.join(directory,'native'));
  verifyTimingReceipt(JSON.parse(fs.readFileSync(path.join(output,'timing-adaptation.json'))));
  const inventory = createRequire(import.meta.url)("../../runtime/bundled-native").fileInventory(output);
  const files = inventory.filter(relative => relative !== "provider.json").map(relative => {
    const file = path.join(output, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The neural provider requires regular installed files.");
    return { path: relative, size: stat.size, sha256: sha256(file),
      ...([source.library,"maclauncher-neural-service","maclauncher-neural-video"].includes(relative)?{architectures:["arm64"],minimumMacOS:relative==="maclauncher-neural-video"?"26.0":source.minimumMacOS,optionalLoad:true}:{}) };
  });
  const descriptor = { providerABI: source.providerABI, commit: sourceRevision(source), library: source.library,
    minimumMacOS: source.minimumMacOS, architectures: ["arm64"],supportedABIs:[1,2,3],
    operations:["mlx-dlss","mlx-vsr","mlx-sr-image","mlx-sr-scene","mlx-interpolation","realesrgan","nafnet","realcugan","rife","depth-anything-v2-small"],restorationAPI:1,estimatedDepthAPI:1,gpuTimingAPI:1,
    modelArchitectures:Object.fromEntries([...new Set(Object.values(restorationArchitectures).map(row=>row.method))].map(method=>[method,Object.keys(restorationArchitectures).filter(id=>restorationArchitectures[id].method===method)])),
    service:{executable:"maclauncher-neural-service",architectures:["arm64"],minimumMacOS:source.minimumMacOS,protocol:3},files };
  fs.writeFileSync(path.join(output, "provider.json"), JSON.stringify(descriptor, null, 2) + "\n");
  return { output, descriptor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const options={};
  if(arguments_.length===1&&!arguments_[0].startsWith("--"))options.output=arguments_[0];
  else for(let i=0;i<arguments_.length;i+=2){const key=arguments_[i];if(!["--output","--source","--work","--cache"].includes(key)||!arguments_[i+1]||Object.hasOwn(options,key))throw Error("Use --source, --work, --cache and --output.");options[key]=arguments_[i+1];}
  const result=buildProvider({output:options.output||options["--output"],sourceDirectory:options["--source"],buildRoot:options["--work"],cacheRoot:options["--cache"]});
  console.log(JSON.stringify({ output: result.output, providerABI: result.descriptor.providerABI,
    commit: result.descriptor.commit, files: result.descriptor.files.length }));
}
