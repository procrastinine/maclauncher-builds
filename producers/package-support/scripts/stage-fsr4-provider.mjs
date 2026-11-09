import {moduleFile} from '../../../tools/app-source.mjs';
import {gitlink,sourceRevision} from '../../../lib/pins.mjs';
import fs from "node:fs";
import path from "node:path";
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
  owned.set("maclauncher/temporal/fsr4/inputs/weights_lossy2.npz",path.join(path.dirname(directory),archive.path));
  if(!upstream)throw Error("Supply the exact FSR 4 source checkout for this provider.");
  files.set("provider.json",path.join(directory,"provider.json"));
  return {files:new Map([...files].map(([name,file])=>["temporal/fsr4/"+name,file])),owned,profiles:[...metadata.supportedProfiles],
    source:{directory:upstream,relative:"third_party/fsr4-native-macos",commit:sourceRevision(spec)},
    pins:[` ${sourceRevision(spec)} third_party/fsr4-native-macos`,` ${sourceRevision(spec.lite2)} third_party/fsr4-lite2-weights`,...(spec.sources||[]).map((row,index)=>{const revision=index<2?gitlink('producers/package-support/src/external/'+(index===0?'fsr4-sdk-headers':'fsr4-sdk-model')):sourceRevision(row);return ` ${revision} third_party/fsr4-input-${index+1}`;})]};
}
