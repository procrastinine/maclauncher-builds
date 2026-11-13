import {sourceRevision} from '../../../lib/pins.mjs';
import fs from "node:fs";
import {fsr4SourceCommits} from "../src/modules/shared/reshade/temporal/fsr4/provenance.mjs";
import path from "node:path";
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
export function stageFSR4Provider({directory,upstream}){
  const lite2=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,"../src/modules/shared/reshade/temporal/fsr4/lite2.json"),"utf8"));
  const revision=sourceRevision({gitlink:'producers/package-support/src/external/fsr4-metal'});
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path)||row.path==="provider.json")throw Error("Invalid FSR 4 runtime inventory.");
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid FSR 4 runtime resource: "+row.path);
    files.set(row.path,file);
  }
  const owned=new Map();
  const archive=metadata.sourceInputs?.find(row=>row.path==="source-inputs/weights_lossy2.npz");
  owned.set("maclauncher/temporal/fsr4/inputs/weights_lossy2.npz",path.join(path.dirname(directory),archive.path));
  if(!upstream)throw Error("Supply the exact FSR 4 source checkout for this provider.");
  files.set("provider.json",path.join(directory,"provider.json"));
  return {files:new Map([...files].map(([name,file])=>["temporal/fsr4/"+name,file])),owned,profiles:[...metadata.supportedProfiles],
    source:{directory:upstream,relative:"third_party/fsr4-native-macos",commit:revision},
    pins:[` ${revision} third_party/fsr4-native-macos`,` ${sourceRevision(lite2)} third_party/fsr4-lite2-weights`,...fsr4SourceCommits(upstream).map((commit,index)=>` ${commit} third_party/fsr4-input-${index+1}`)]};
}
