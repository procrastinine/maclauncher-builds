import {gitlink} from "../../../lib/pins.mjs";
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
export function stageTemporalProvider({name,directory,upstream,ownedRoot}){
  if(!["asr","sgsr2"].includes(name))throw Error("Choose a registered temporal provider.");
  const spec=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"),"utf8")),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path))throw Error("Invalid temporal provider inventory: "+name);
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Invalid temporal runtime resource: "+row.path);
    files.set(row.path,file);
  }
  const owned=new Map();
  for(const [relative] of Object.entries(metadata.owned)){
    if(!safe(relative)&&!['../frame.h','../command-order.hpp','../payload-files.hpp','../../shaderc-offline.cpp'].includes(relative))throw Error("Invalid owned temporal build input.");
    const file=path.resolve(ownedRoot,relative),target=path.posix.normalize(`maclauncher/temporal/${name}/${relative}`);
    if(!target.startsWith("maclauncher/")||(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error("Temporal provider source changed: "+relative);
    owned.set(target,file);
  }
  if(!upstream)throw Error("Supply the declared source checkout for the optional "+name+" provider.");
  const git=args=>execFileSync("git",["-C",upstream,...args],{encoding:"utf8"}).trim();
  const canonical=url=>url.replace(/\.git$/,"").replace(/\/$/,"");
  if(git(["rev-parse","HEAD"])!==gitlink(spec.gitlink)||canonical(git(["remote","get-url","origin"]))!==canonical(spec.repository))throw Error("Temporal provider checkout differs from its declared public origin or exact commit.");
  git(["diff","--exit-code","--ignore-submodules=all","HEAD","--"]);
  if(!Array.isArray(spec.sourceScope)||!spec.sourceScope.length||spec.sourceScope.some(value=>!safe(value)))throw Error("The temporal provider source scope is undeclared.");
  return {files:new Map([...files].map(([relative,file])=>[`temporal/${name}/${relative}`,file]).concat([[`temporal/${name}/provider.json`,path.join(directory,"provider.json")]])),owned,
    source:{directory:upstream,relative:"third_party/"+name,commit:gitlink(spec.gitlink),scope:spec.sourceScope},pin:` ${gitlink(spec.gitlink)} third_party/${name}`};
}
