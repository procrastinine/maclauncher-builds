import {appSourceRoot} from '../../../../../../../tools/app-source.mjs';
import {buildCameraBridge} from '../camera-bridge/build.mjs';
import {gitlink} from '../../../../../../../lib/pins.mjs';
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => index % 2 ? items : [...items, [value.replace(/^--/, ""), all[index + 1]]], []));
if (!["source", "out", "compiler", "reference"].every(key => args[key])) throw Error("Use --source Streamline --out directory --compiler clang++ --reference sl.interposer.dll");
const source = path.resolve(args.source), output = path.resolve(args.out), reference = path.resolve(args.reference);
const declaration = JSON.parse(fs.readFileSync(path.join(here, "source.json"), "utf8"));
const revision = gitlink(declaration.gitlink);
const app = appSourceRoot(), owned = path.join(app.directory, "src/modules/crossover/temporal/streamline");
if (execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== revision) throw Error("Streamline headers must match the pinned source revision");
execFileSync("git",["-C",source,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});
const inspect = require(path.join(owned,"pe-exports.js")).inspect;
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const core = [...fs.readFileSync(path.join(source, "include/sl_core_api.h"), "utf8").matchAll(/^sl::Result (sl\w+)\(|^SL_API sl::Result (sl\w+)\(/gm)].map(match => match[1] || match[2]);
const known = new Set([...fs.readFileSync(path.join(source, "source/core/sl.interposer/exports.def"), "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z_]\w*$/.test(line) && line !== "EXPORTS"), ...core, "slSetVulkanInfo"]);
function buildAdapter(reference, output) {
const exports = inspect(reference);
if (!exports) throw Error("A complete named x64 Streamline export table is required");
if (exports.some(item => !known.has(item.name)) || ["slSetConstants", "slEvaluateFeature", "slShutdown"].some(name => !exports.some(item => item.name === name))) throw Error("The reference exports do not match the pinned Streamline API");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "exports.def"), "LIBRARY sl.interposer\nEXPORTS\n" + exports.map(item => `${item.name} @${item.ordinal}`).join("\n") + "\n");
fs.writeFileSync(path.join(output, "exports.hpp"), `#pragma once\n#define MACLAUNCHER_HAS_SL_SET_TAG_FOR_FRAME ${exports.some(row=>row.name==="slSetTagForFrame")?1:0}\nconstexpr unsigned maclauncherExportCount = ${exports.length};\nstatic const char *maclauncherExportNames[] = {${exports.map(item => JSON.stringify(item.name)).join(",")}};\nextern "C" void *maclauncherTargets[maclauncherExportCount];\n`);
const hooks = new Set(["slSetConstants", "slEvaluateFeature", "slShutdown", "slSetD3DDevice", "slSetTag", "slSetTagForFrame"]);
const thunks = exports.flatMap(({ name }, i) => hooks.has(name) ? [] : [`
.text
.p2align 4
.globl ${name}
.def ${name}; .scl 2; .type 32; .endef
.seh_proc ${name}
${name}:
    movq maclauncherTargets+${i * 8}(%rip), %rax
    testq %rax, %rax
    jne .Lready${i}
    subq $136, %rsp
    .seh_stackalloc 136
    .seh_endprologue
    movq %rcx, 32(%rsp)
    movq %rdx, 40(%rsp)
    movq %r8, 48(%rsp)
    movq %r9, 56(%rsp)
    movups %xmm0, 64(%rsp)
    movups %xmm1, 80(%rsp)
    movups %xmm2, 96(%rsp)
    movups %xmm3, 112(%rsp)
    movl $${i}, %ecx
    call maclauncherResolveExport
    movq 32(%rsp), %rcx
    movq 40(%rsp), %rdx
    movq 48(%rsp), %r8
    movq 56(%rsp), %r9
    movups 64(%rsp), %xmm0
    movups 80(%rsp), %xmm1
    movups 96(%rsp), %xmm2
    movups 112(%rsp), %xmm3
    addq $136, %rsp
.Lready${i}:
    jmp *%rax
.seh_endproc
`]).join("\n");
fs.writeFileSync(path.join(output, "thunks.S"), thunks);
execFileSync(path.resolve(args.compiler), ["-std=c++17", "-O2", "-shared", "-static", "-Wl,--exclude-all-symbols", "-Wl,--no-insert-timestamp", "-I" + path.join(source, "include"), "-I" + output,
  "-I"+path.resolve(owned,"../../../shared/reshade/temporal"),"-I"+path.resolve(owned,"../../../shared/reshade/native"),
  path.join(owned, "proxy.cpp"), path.join(output, "thunks.S"), path.join(output, "exports.def"), "-o", path.join(output, "sl.interposer.dll")], { stdio: "inherit" });
const actual = inspect(path.join(output,"sl.interposer.dll"));
if (JSON.stringify(actual)!==JSON.stringify(exports)) throw Error("The camera adapter export table differs from its complete reference");
return {schema:1,library:"sl.interposer.dll",sha256:hash(path.join(output,"sl.interposer.dll")),referenceSha256:hash(reference),exports};
}
const metadata = buildAdapter(reference,output);
metadata.version="3";metadata.resourceSnapshotAPI=1;metadata.resourceSnapshotProfiles=["d3d11-v2"];
metadata.resourceTagProfiles=["slSetD3DDevice","slSetTag","slSetTagForFrame"].every(name=>metadata.exports.some(row=>row.name===name))?["d3d11-v1"]:[];
metadata.source={url:declaration.repository,revision,version:"2.9.0"};metadata.appSource={repository:app.repository||"https://github.com/procrastinine/maclauncher",revision:app.revision};
metadata.profiles=[];
for(const profile of declaration.referenceProfiles||[]){
 const referenceFile=args["compat-reference"]?path.resolve(args["compat-reference"]):path.join(output,"references",profile.version,"sl.interposer.dll");
 if(!fs.existsSync(referenceFile)){
  const response=await fetch(profile.reference.url);if(!response.ok)throw Error("Streamline reference download failed: "+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length!==profile.reference.bytes||crypto.createHash("sha256").update(bytes).digest("hex")!==profile.reference.sha256)throw Error("Streamline reference identity differs");
  fs.mkdirSync(path.dirname(referenceFile),{recursive:true});fs.writeFileSync(referenceFile,bytes);
 }
 if(fs.statSync(referenceFile).size!==profile.reference.bytes||hash(referenceFile)!==profile.reference.sha256)throw Error("Streamline reference identity differs");
 const table=inspect(referenceFile);if(!table)throw Error("Invalid complete Streamline reference table");
 if(JSON.stringify(table)===JSON.stringify(metadata.exports))continue;
 const directory="compat/"+profile.version;
 const candidate=buildAdapter(referenceFile,path.join(output,directory));
 metadata.profiles.push({...candidate,directory,referenceSource:{url:declaration.repository,revision:profile.revision,version:profile.version}});
}
const cameraBridge=buildCameraBridge({compiler:path.join(path.dirname(path.resolve(args.compiler)),"x86_64-w64-mingw32-clang"),output});
metadata.cameraBridge={...cameraBridge,files:Object.fromEntries([cameraBridge.windows,cameraBridge.unix].map(file=>[file,hash(path.join(output,file))]))};
metadata.compiler=execFileSync(path.resolve(args.compiler),["--version"],{encoding:"utf8"}).split("\n")[0];
metadata.sources=Object.fromEntries(["build.mjs","source.json","proxy.cpp","../camera-bridge/build.mjs","../camera-bridge/bridge.c","../camera-bridge/bridge-unix.c","../camera-bridge/protocol.h","camera.hpp","resources.hpp","snapshots.hpp","snapshot-budget.hpp","../dxmt/camera-transport.hpp","../dxmt/streamline-transport.hpp","../dxmt/streamline-snapshot.hpp","pe-exports.js","../../../shared/reshade/temporal/camera.h","../../../shared/reshade/temporal/frame.h","../../../shared/reshade/native/image-color.h","../../../shared/reshade/native/image-budget.hpp"].map(file=>[file,hash(path.resolve(file==="build.mjs"||file==="source.json"||file.startsWith("../camera-bridge/")?here:owned,file))]));
addLicenses(output,"Streamline",source);
fs.writeFileSync(path.join(output,"provider.json"),JSON.stringify(metadata,null,2)+"\n");
console.log(JSON.stringify({library:path.join(output,metadata.library),exports:metadata.exports.length,profiles:metadata.profiles.map(row=>({directory:row.directory,exports:row.exports.length})),sha256:metadata.sha256}));
