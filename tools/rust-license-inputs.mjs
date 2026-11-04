import fs from 'node:fs';
import path from 'node:path';
import {downloadFile} from './download.mjs';
/** Optional original notice candidates for crates whose source archives omit text. */
export async function rustLicenseInputs({file,output}){
 let declaration;try{declaration=JSON.parse(fs.readFileSync(file));}catch(error){console.warn('::warning::Could not read crate notices: '+error.message);return {licenseInputs:[],provenance:{crates:[]}};}
 const licenses=[],omittedStandardLicenseInputs=[],base=path.dirname(file);
 for(const row of Array.isArray(declaration.crates)?declaration.crates:[]){
  if(!row||typeof row.name!=='string'||typeof row.version!=='string')continue;
  const selected={name:row.name,version:row.version,license:row.license,authors:row.authors,files:[]};
  for(const entry of Array.isArray(row.files)?row.files:[]){
   if(!entry||entry.standardLicense){if(entry)omittedStandardLicenseInputs.push({name:row.name,version:row.version,filename:entry.filename});continue;}
   const candidate={name:row.name+' '+row.version,license:row.license,sourceUrl:entry.url||entry.standardLicense?.url,path:row.name+'-'+row.version+'/'+String(entry.filename||'notice.txt')};
   const target=path.join(output,candidate.path);let source=entry.file?path.resolve(base,entry.file):target+'.download';try{if(!entry.file){fs.mkdirSync(path.dirname(source),{recursive:true});await downloadFile(entry.url,source);}selected.files.push({file:source,sourceUrl:candidate.sourceUrl});}catch(error){console.warn('::warning::Could not collect crate notice: '+error.message);}
  }
  licenses.push(selected);
 }
 return {licenseInputs:licenses,provenance:{crates:licenses.map(({files,...row})=>row),omittedStandardLicenseInputs}};
}
