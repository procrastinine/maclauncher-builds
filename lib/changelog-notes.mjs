import fs from 'node:fs';
import path from 'node:path';

/** Optional source notes; unknown headings warn without affecting package generation. */
export function projectNotes(directory,id,knownVersions,{warn=console.warn}={}){
 const file=path.join(directory,'changelog',id+'.md');
 if(!fs.existsSync(file))return new Map();
 let text;
 try{text=fs.readFileSync(file,'utf8');}
 catch{warn('Changelog '+id+': notes file could not be read.');return new Map();}
 const headings=[...text.matchAll(/^##[ \t]+([^\r\n]+)[ \t]*$/gm)];
 const notes=new Map();
 for(const [index,heading] of headings.entries()){
  const version=heading[1].trim();
  if(!knownVersions.has(version)){
   warn('Changelog '+id+': '+version+' has no published or pending version.');
  }
  const body=text.slice(heading.index+heading[0].length,headings[index+1]?.index??text.length).trim();
  if(body)notes.set(version,body);
 }
 return notes;
}
