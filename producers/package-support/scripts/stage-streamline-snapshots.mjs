import {moduleFile} from '../../../tools/app-source.mjs';
import fs from "node:fs";
import path from "node:path";
const origins=Object.freeze({streamline:"https://github.com/NVIDIA-RTX/Streamline",dxmt:"https://github.com/3Shain/dxmt"});

export function stageStreamlineSnapshots({name,directory,metadata}){
  if(metadata.resourceSnapshotAPI===undefined)return null;
  if(!Object.hasOwn(origins,name)||metadata.resourceSnapshotAPI!==1||metadata.source?.url!==origins[name]||!/^[a-f0-9]{40}$/.test(metadata.source?.revision||""))throw Error("The tagged GPU snapshot source contract is invalid.");
  const sources=metadata.sources;
  const owned=new Map(),module="src/modules/crossover/temporal/"+name;
  for(const relative of Object.keys(sources))owned.set(path.posix.normalize(`maclauncher/crossover/temporal/${name}/${relative}`),moduleFile(path.posix.join(module,relative)));
  return {owned,pin:` ${metadata.source.revision} third_party/${name}-snapshot`};
}
