import {moduleFile} from '../../../tools/app-source.mjs';
import {sourceRevision} from '../../../lib/pins.mjs';
import fs from "node:fs";
import path from "node:path";
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
export function stageTemporalProvider({name,directory,upstream}){
  if(!["asr","sgsr2"].includes(name))throw Error("Choose a registered temporal provider.");
  const module="src/modules/shared/reshade/temporal/"+name,spec=JSON.parse(fs.readFileSync(moduleFile(module+"/source.json"),"utf8")),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path))throw Error("Invalid temporal provider inventory: "+name);
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid temporal runtime resource: "+row.path);
    files.set(row.path,file);
  }
  if(!upstream)throw Error("Supply the declared source checkout for the optional "+name+" provider.");
  return {files:new Map([...files].map(([relative,file])=>[`temporal/${name}/${relative}`,file]).concat([[`temporal/${name}/provider.json`,path.join(directory,"provider.json")]])),
    source:{directory:upstream,relative:"third_party/"+name,commit:sourceRevision({gitlink:"producers/package-support/src/external/"+name}),scope:spec.sourceScope},pin:` ${sourceRevision({gitlink:"producers/package-support/src/external/"+name})} third_party/${name}`};
}
