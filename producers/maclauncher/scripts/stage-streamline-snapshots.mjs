import {appSourceRoot} from '../../../tools/app-source.mjs';
import fs from "node:fs";
import path from "node:path";
const origins=Object.freeze({streamline:"https://github.com/NVIDIA-RTX/Streamline",dxmt:"https://github.com/3Shain/dxmt"});

export function stageStreamlineSnapshots({name,directory,metadata,recipeRoot}){
  if(metadata.resourceSnapshotAPI===undefined)return null;
  if(!Object.hasOwn(origins,name)||metadata.resourceSnapshotAPI!==1||metadata.source?.url!==origins[name]||!/^[a-f0-9]{40}$/.test(metadata.source?.revision||""))throw Error("The tagged GPU snapshot source contract is invalid.");
  const sources=metadata.sources;
  const owned=new Map(),root=path.join(recipeRoot,name);
  for(const relative of Object.keys(sources)){
    const appOwned=name==="streamline"&&relative!=="build.mjs"&&relative!=="source.json"&&!relative.startsWith("../camera-bridge/");
    const actualRoot=appOwned?path.join(appSourceRoot().directory,"src/modules/crossover/temporal/streamline"):root;
    const file=path.resolve(actualRoot,relative),stat=fs.lstatSync(file);
    if(!file.startsWith(path.resolve(appOwned?actualRoot:recipeRoot,appOwned?"../../..":"../..")+path.sep)||!stat.isFile()||stat.isSymbolicLink())throw Error("The tagged GPU snapshot build input changed: "+relative);
    owned.set(path.posix.normalize(`maclauncher/crossover/temporal/${name}/${relative}`),file);
  }
  return {owned,pin:` ${metadata.source.revision} third_party/${name}-snapshot`};
}
