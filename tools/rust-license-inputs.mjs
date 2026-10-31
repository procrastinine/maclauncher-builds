import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildInput} from './build-input.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
/** Explicit notice inputs for locked crates whose archives omit their license text. */
export async function rustLicenseInputs({file,output}){
 const bytes=fs.readFileSync(file),declaration=JSON.parse(bytes),base=path.dirname(file),seen=new Set(),licenses=[],omittedStandardLicenseInputs=[];
 if(declaration.schemaVersion!==1||!Array.isArray(declaration.crates)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select a crate license declaration and new absolute output directory.');
 fs.mkdirSync(output,{recursive:true});
 for(const row of declaration.crates){
  const key=row.name+'@'+row.version;
  if(!/^[A-Za-z0-9_-]+$/.test(row.name||'')||!/^\d[\w.+-]*$/.test(row.version||'')||seen.has(key)||!row.license||!Array.isArray(row.authors)||!Array.isArray(row.files))throw Error('Invalid declared crate license: '+key);
  seen.add(key);const selected={name:row.name,version:row.version,license:row.license,authors:row.authors,files:[]};
  for(const entry of row.files){
   if(!entry.filename||path.basename(entry.filename)!==entry.filename||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Invalid declared crate notice: '+key);
   let source;
   if(entry.file){
    source=path.resolve(base,entry.file);
    if(!source.startsWith(base+path.sep)||fs.realpathSync(source)!==source||!fs.statSync(source).isFile())throw Error('Crate notice must be an original file beside its declaration.');
   }else source=await buildInput(entry);
   const data=fs.readFileSync(source);
   if(sha(data)!==entry.sha256||entry.bytes!==data.length||data.length<20)throw Error('Declared crate notice checksum or size differs: '+key);
   const sourceUrl=entry.url||entry.standardLicense?.url;
   if(!/^https:\/\//.test(sourceUrl||''))throw Error('A crate notice needs its original public source.');
   if(entry.standardLicense){omittedStandardLicenseInputs.push({name:row.name,version:row.version,filename:entry.filename});continue;}
   const destination=path.join(output,row.name+'-'+row.version,entry.filename);
   fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,data,{mode:0o644,flag:'wx'});
   selected.files.push({file:destination,sourceUrl});
  }
  if(!selected.files.length)console.warn('No upstream license text supplied for '+key);
  licenses.push(selected);
 }
 return {licenseInputs:licenses,provenance:{declarationSha256:sha(bytes),crates:declaration.crates,omittedStandardLicenseInputs}};
}
