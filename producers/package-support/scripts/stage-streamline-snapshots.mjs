import {moduleFile} from '../../../tools/app-source.mjs';
import fs from "node:fs";
import path from "node:path";

export function stageStreamlineSnapshots({name,directory,metadata}){
  if(metadata.resourceSnapshotAPI===undefined)return null;
  const sources=metadata.sources;
  const owned=new Map(),module="src/modules/crossover/temporal/"+name;
  for(const relative of Object.keys(sources))owned.set(path.posix.normalize(`maclauncher/crossover/temporal/${name}/${relative}`),moduleFile(path.posix.join(module,relative)));
  return {owned,pin:` ${metadata.source.revision} third_party/${name}-snapshot`};
}
