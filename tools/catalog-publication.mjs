import fs from 'node:fs';
import path from 'node:path';
import {catalog} from './runtime-package.mjs';
import {validateCatalog} from '../lib/project-identity.mjs';
import {partitionCatalog} from './build-coverage.mjs';
const json=value=>JSON.stringify(value,null,2)+'\n';
const identity=record=>record.version+'/'+record.arch;
const stable=value=>JSON.stringify(value,(_,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
function write(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp-'+process.pid;
 try{fs.writeFileSync(temporary,json(value),{flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
}

/** Incoming records have passed the publication gate. Preserve older local records separately. */
export function writePublicationCatalog({records,project,repository,directory,output,previous}){
 const superseded=path.join(path.dirname(output),'superseded',path.basename(output));
 const oldSuperseded=fs.existsSync(superseded)?validateCatalog(JSON.parse(fs.readFileSync(superseded)),{project,repository,allowEmpty:true}):undefined;
 const history=new Map();
 for(const record of [...(previous?.packages||[]),...(oldSuperseded?.packages||[])]){
  const key=identity(record),old=history.get(key);
  if(old&&stable(old)!==stable(record))throw Error('Active and superseded catalogs disagree about an immutable package.');
  history.set(key,record);
 }
 const prior=history.size?{schemaVersion:2,projectId:project,updatePolicy:'manual',packages:[...history.values()]}:undefined;
 const combined=catalog(records,{project,repository,previous:prior}),incoming=new Set(records.map(identity));
 const retained=partitionCatalog({records:combined.packages.filter(record=>!incoming.has(identity(record))),repository,directory});
 const activeKeys=new Set(retained.active.map(identity));
 const active={...combined,packages:combined.packages.filter(record=>incoming.has(identity(record))||activeKeys.has(identity(record)))};
 const local={...combined,packages:retained.local};
 validateCatalog(active,{project,repository});validateCatalog(local,{project,repository,allowEmpty:true});
 // Preserve historical records before replacing the active catalog.
 if(local.packages.length||oldSuperseded)write(superseded,local);
 write(output,active);
 return active;
}
