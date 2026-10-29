import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

const own=(value,key)=>Object.hasOwn(value,key);
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const fields=new Set(['file','pointer','repositoryPointer','match','field']);
const revision=/^[a-f0-9]{40}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function validatePinReference(pin){
 if(!record(pin)||Object.keys(pin).some(key=>!fields.has(key))||typeof pin.file!=='string'||
    !(/\.json$/.test(pin.file)||/^producers\/.*\.(?:js|cjs)$/.test(pin.file))||!pin.file.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)&&part!=='.'&&part!=='..'))
  throw Error('A source pin requires a relative public JSON file or owned CommonJS producer export.');
 if(own(pin,'match')&&(!record(pin.match)||!Object.keys(pin.match).length||Object.values(pin.match).some(value=>!['string','number','boolean'].includes(typeof value))))throw Error('A source pin entry match requires scalar identity fields.');
 if(own(pin,'field')&&!own(pin,'match'))throw Error('A source pin field requires an entry match.');
 for(const key of ['pointer',...(own(pin,'repositoryPointer')?['repositoryPointer']:[]),...(own(pin,'field')?['field']:[])]){
  const value=pin[key];if(typeof value!=='string'||value!==''&&!value.startsWith('/')||/~(?![01])/u.test(value))throw Error('A source pin requires a valid JSON pointer.');
 }
 return pin;
}

function select(value,pointer){
 if(pointer==='')return value;
 for(const encoded of pointer.slice(1).split('/')){
  const key=encoded.replaceAll('~1','/').replaceAll('~0','~');
  if(value===null||typeof value!=='object'||!own(value,key))throw Error('Source pin JSON pointer does not exist: '+pointer);
  value=value[key];
 }
 return value;
}

function metadata(root,file,cache){
 if(cache.has(file))return cache.get(file);
 const base=fs.realpathSync(root),requested=path.resolve(base,file);
 let target,stat;try{target=fs.realpathSync(requested);stat=fs.statSync(target);}catch{throw Error('Source pin metadata is unavailable: '+file);}
 if(!inside(base,target)||!stat.isFile()||stat.size>1024*1024)throw Error('Source pin metadata must be a contained public JSON file.');
 let value;
 if(file.endsWith('.json')){try{value=JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw Error('Source pin metadata is invalid JSON: '+file);}}
 else {
  // These are the same trusted owned modules loaded by their build tools.
  // Read-only metadata consumers never enter this path. Each resolution gets
  // a fresh selected export, shared within that registry read.
  delete require.cache[require.resolve(target)];value=require(target);
 }
 cache.set(file,value);return value;
}

function origin(value){
 if(typeof value!=='string')throw Error('Source pin repository is invalid.');
 if(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))value='https://github.com/'+value;
 let parsed;try{parsed=new URL(value);}catch{throw Error('Source pin repository is invalid.');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Source pin repository must be a public HTTPS origin.');
 return parsed.origin+parsed.pathname.replace(/\/$/,'').replace(/\.git$/,'');
}

/** Resolve a selected producer record; no Git, network, or copied-value fallback. */
export function resolveUpstream(upstream,root,{resolvePins=true,cache=new Map()}={}){
 if(!own(upstream,'pin'))return {...upstream};
 const pin=validatePinReference(upstream.pin);
 if(['revision','version','committedAt'].some(key=>own(upstream,key)))throw Error('A referenced source pin cannot also declare a revision, version or timestamp override.');
 if(!resolvePins)return {...upstream,pin:{...pin}};
 const json=metadata(root,pin.file,cache);let selected=select(json,pin.pointer);
 if(own(pin,'match')){
  if(!Array.isArray(selected))throw Error('Source pin entry match must select an array.');
  const matches=selected.filter(entry=>record(entry)&&Object.entries(pin.match).every(([key,value])=>own(entry,key)&&entry[key]===value));
  if(matches.length!==1)throw Error('Source pin entry match must identify exactly one profile.');
  selected=own(pin,'field')?select(matches[0],pin.field):matches[0];
 }
 let value;
 if(typeof selected==='string')value={revision:selected};
 else if(record(selected)){
  if(own(selected,'revision')&&own(selected,'commit')&&selected.revision!==selected.commit)throw Error('Source pin metadata contains conflicting revisions.');
  value={revision:selected.revision??selected.commit};
  for(const key of ['version','committedAt'])if(own(selected,key))value[key]=selected[key];
 }else throw Error('Source pin must select a commit or source record.');
 if(typeof value.revision!=='string'||!revision.test(value.revision))throw Error('Source pin metadata has no exact commit revision.');
 if(own(value,'version')&&(typeof value.version!=='string'||!value.version.length))throw Error('Source pin version is invalid.');
 if(own(value,'committedAt')&&(typeof value.committedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.committedAt)||!Number.isFinite(Date.parse(value.committedAt))))throw Error('Source pin timestamp is invalid.');
 const origins=[];
 if(record(selected))for(const key of ['repository','url'])if(own(selected,key))origins.push(selected[key]);
 if(own(pin,'repositoryPointer'))origins.push(select(json,pin.repositoryPointer));
 for(const source of origins)if(origin(source)!==origin(upstream.url))throw Error('Source pin repository differs from the registered upstream.');
 const {pin:reference,...description}=upstream;
 return {...description,...value};
}
