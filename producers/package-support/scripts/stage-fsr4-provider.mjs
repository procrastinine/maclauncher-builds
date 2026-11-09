import {moduleFile} from '../../../tools/app-source.mjs';
import {gitlink,sourceRevision} from '../../../lib/pins.mjs';
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
const module="src/modules/shared/reshade/temporal/fsr4";
export function stageFSR4Provider({directory,upstream}){
  const spec=JSON.parse(fs.readFileSync(moduleFile(module+"/source.json"))),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path)||row.path==="provider.json")throw Error("Invalid FSR 4 runtime inventory.");
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid FSR 4 runtime resource: "+row.path);
    files.set(row.path,file);
  }
  const owned=new Map();
  for(const relative of Object.keys(metadata.owned))owned.set(path.posix.normalize("maclauncher/temporal/fsr4/"+relative),moduleFile(path.posix.join(module,relative)));
  const archive=metadata.sourceInputs?.find(row=>row.path==="source-inputs/weights_lossy2.npz");
  if(!archive||metadata.sourceInputs.length!==1||archive.sha256!==spec.lite2.sha256||archive.repository!==spec.lite2.repository||archive.commit!==spec.lite2.commit||![spec.lite2.url,spec.lite2.repository+"/tree/"+spec.lite2.commit].includes(archive.sourceUrl))throw Error("The Lite 2 source archive identity is incomplete.");
  const archiveFile=path.join(path.dirname(directory),archive.path),archiveStat=fs.lstatSync(archiveFile);
  if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.size!==archive.size||hash(archiveFile)!==archive.sha256)throw Error("A Lite 2 source input changed.");
  owned.set("maclauncher/temporal/fsr4/inputs/weights_lossy2.npz",archiveFile);
  if(!upstream)throw Error("Supply the exact FSR 4 source checkout for this provider.");
  const git=args=>execFileSync("git",["-C",upstream,...args],{encoding:"utf8"}).trim(),canonical=url=>url.replace(/\.git$/,"").replace(/\/$/,"");
  if(git(["rev-parse","HEAD"])!==sourceRevision(spec)||canonical(git(["remote","get-url","origin"]))!==canonical(spec.repository))throw Error("The FSR 4 checkout differs from its declared public origin or commit.");
  git(["diff","--exit-code","--ignore-submodules=all","HEAD","--"]);
  files.set("provider.json",path.join(directory,"provider.json"));
  return {files:new Map([...files].map(([name,file])=>["temporal/fsr4/"+name,file])),owned,profiles:[...metadata.supportedProfiles],
    source:{directory:upstream,relative:"third_party/fsr4-native-macos",commit:sourceRevision(spec)},
    pins:[` ${sourceRevision(spec)} third_party/fsr4-native-macos`,` ${spec.lite2.commit} third_party/fsr4-lite2-weights`,...(spec.sources||[]).map((row,index)=>{const revision=index<2?gitlink('producers/package-support/src/external/'+(index===0?'fsr4-sdk-headers':'fsr4-sdk-model')):sourceRevision(row);if(!/^https:\/\//.test(row.repository||" ")||!/^[a-f0-9]{40}$/.test(revision||" "))throw Error("An FSR 4 consumed source pin is incomplete.");return ` ${revision} third_party/fsr4-input-${index+1}`;})]};
}
