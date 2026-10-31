import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const FILES=Object.freeze(['LICENSE.txt','src/hidapi/LICENSE.txt','src/hidapi/LICENSE-bsd.txt','src/hidapi/LICENSE-orig.txt','src/hidapi/LICENSE-gpl3.txt','src/hidapi/AUTHORS.txt','src/video/yuv2rgb/LICENSE']);
/** Original SDL and bundled-component notices from a declared source tree. */
export function collectSdlNotices({source,output,name='SDL',sourceUrl,includeLibm=false}){
 if(!path.isAbsolute(source||'')||!path.isAbsolute(output||'')||fs.existsSync(output)||!/^https:\/\//.test(sourceUrl||'')||typeof includeLibm!=='boolean')throw Error('SDL notices need a declared source, public origin and new absolute output directory.');
 source=fs.realpathSync(source);output=path.resolve(output);
 if(output===source||output.startsWith(source+path.sep))throw Error('SDL notice output must be separate from its source.');
 fs.mkdirSync(output,{recursive:true});const notices=[],files=[];
 const write=(relative,input,bytes,kind)=>{const destination=path.join(output,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o644});notices.push({file:destination,name:name+' '+input,license:'See original notice',sourceUrl});files.push({source:input,notice:relative,sourceSha256:sha(fs.readFileSync(path.join(source,input))),noticeSha256:sha(bytes),kind});};
 for(const relative of FILES){const file=path.join(source,relative);if(!fs.lstatSync(file).isFile())throw Error('SDL source notice is missing: '+relative);write(relative,relative,fs.readFileSync(file),'original-file');}
 if(includeLibm){let count=0;const directory=path.join(source,'src/libm');
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(!entry.isFile()||!/[.](?:c|h)$/.test(entry.name))continue;
   const relative='src/libm/'+entry.name,bytes=fs.readFileSync(path.join(source,relative)),comments=[...bytes.toString('latin1').matchAll(/\/\*[\s\S]*?\*\//g)].map(match=>match[0]).filter(comment=>/copyright/i.test(comment));
   if(!comments.length)continue;write('libm/'+entry.name+'.LICENSE.txt',relative,Buffer.from(comments.join('\n\n')+'\n','latin1'),'complete-original-copyright-comments');count++;
  }
  if(!count)throw Error('The selected SDL libm code has no original copyright notices.');
 }
 return {notices,provenance:{name,sourceUrl,includeLibm,files}};
}
