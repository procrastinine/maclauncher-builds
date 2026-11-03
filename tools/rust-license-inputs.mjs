import fs from 'node:fs';
import path from 'node:path';
import {copyNotices,fetchNotices,printWarnings} from '../lib/notices.mjs';
/** Optional original notice candidates for crates whose source archives omit text. */
export async function rustLicenseInputs({file,output}){
 let declaration;try{declaration=JSON.parse(fs.readFileSync(file));}catch(error){printWarnings(['Could not read crate notices: '+error.message]);return {licenseInputs:[],provenance:{crates:[]}};}
 const licenses=[],omittedStandardLicenseInputs=[],base=path.dirname(file);
 for(const row of Array.isArray(declaration.crates)?declaration.crates:[]){
  if(!row||typeof row.name!=='string'||typeof row.version!=='string')continue;
  const selected={name:row.name,version:row.version,license:row.license,authors:row.authors,files:[]};
  for(const entry of Array.isArray(row.files)?row.files:[]){
   if(!entry||entry.standardLicense){if(entry)omittedStandardLicenseInputs.push({name:row.name,version:row.version,filename:entry.filename});continue;}
   const candidate={name:row.name+' '+row.version,license:row.license,sourceUrl:entry.url||entry.standardLicense?.url,path:row.name+'-'+row.version+'/'+(entry.filename||'notice.txt')};
   const result=entry.file?copyNotices([{...candidate,file:path.resolve(base,entry.file)}],{output}):await fetchNotices([{...candidate,url:entry.url}],{output});
   printWarnings(result.warnings);selected.files.push(...result.notices.map(notice=>({file:notice.file,sourceUrl:notice.sourceUrl})));
  }
  licenses.push(selected);
 }
 return {licenseInputs:licenses,provenance:{crates:licenses.map(({files,...row})=>row),omittedStandardLicenseInputs}};
}
