import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const object=(type,bytes)=>crypto.createHash('sha1').update(type+' '+bytes.length+'\0').update(bytes).digest();
export function gitSourceObject(file){
 const stat=fs.lstatSync(file);
 if(stat.isSymbolicLink())return object('blob',Buffer.from(fs.readlinkSync(file)));
 if(stat.isFile())return object('blob',fs.readFileSync(file));
 if(!stat.isDirectory())throw Error('The selected Git source contains a special file.');
 const entries=fs.readdirSync(file).map(name=>{const full=path.join(file,name),s=fs.lstatSync(full),directory=s.isDirectory();return {name,file:full,sort:name+(directory?'/':''),mode:directory?'40000':s.isSymbolicLink()?'120000':s.mode&0o111?'100755':'100644'};});
 entries.sort((a,b)=>Buffer.compare(Buffer.from(a.sort),Buffer.from(b.sort)));
 return object('tree',Buffer.concat(entries.map(entry=>Buffer.concat([Buffer.from(entry.mode+' '+entry.name+'\0'),gitSourceObject(entry.file)]))));
}

/** Acquire immutable selected Gitiles objects without fetching other compiler versions. */
export async function acquireArtSourceSelection(record,destination){
 if(!path.isAbsolute(destination)||fs.existsSync(destination)||!/^https:\/\/android\.googlesource\.com\//.test(record.repository)||!/^([a-f0-9]{40})$/.test(record.revision)||!record.selection?.length)throw Error('An exact public Android Git source and selected objects are required.');
 fs.mkdirSync(destination,{recursive:true});const receipts=[];
 for(const selected of record.selection){
  if(!selected||path.isAbsolute(selected)||selected.split('/').includes('..'))throw Error('The selected Git input path is invalid.');
  const expected=record.objects?.[selected];if(!/^[a-f0-9]{40}$/.test(expected?.id||'')||!['tree','blob'].includes(expected.type)||expected.mode!==undefined&&!(expected.type==='tree'?['40000']:['100644','100755','120000']).includes(expected.mode))throw Error('A selected Git input requires its original Git object identity.');
  const output=path.join(destination,selected),archive=path.join(destination,'.input-'+crypto.randomUUID());fs.mkdirSync(path.dirname(output),{recursive:true});
  const url=record.repository+(expected.type==='tree'?'/+archive/':'/+/')+record.revision+'/'+selected+(expected.type==='tree'?'.tar.gz':'?format=TEXT');
  try{
   await execute('curl',['--fail','--silent','--show-error','--location','--retry','2','--retry-all-errors','--proto','=https','--proto-redir','=https','--max-time','600','--output',archive,url],{timeout:610000,maxBuffer:4<<20});
   const size=fs.statSync(archive).size,transportSha256=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(archive))transportSha256.update(bytes);
   if(expected.type==='tree'){
    const {stdout}=await execute('/usr/bin/tar',['-tzf',archive],{maxBuffer:8<<20});
    if(stdout.split('\n').filter(Boolean).some(name=>path.isAbsolute(name)||name.split('/').includes('..')))throw Error('Selected Git archive leaves its source root.');
    fs.mkdirSync(output);await execute('/usr/bin/tar',['-xzf',archive,'-C',output],{maxBuffer:4<<20});
   }else{
    const bytes=Buffer.from(fs.readFileSync(archive,'utf8'),'base64');
    if(expected.mode==='120000'){
     const target=bytes.toString('utf8'),resolved=path.resolve(path.dirname(output),target);
     if(!target||target.includes('\0')||path.isAbsolute(target)||!resolved.startsWith(destination+path.sep))throw Error('Selected Git alias leaves its source root.');
     fs.symlinkSync(target,output);
    }else fs.writeFileSync(output,bytes,{flag:'wx',mode:expected.mode==='100755'?0o755:0o644});
   }
   const stat=fs.lstatSync(output),mode=stat.isDirectory()?'40000':stat.isSymbolicLink()?'120000':stat.mode&0o111?'100755':'100644';
   if(expected.mode&&mode!==expected.mode)throw Error('Selected Git source mode differs: '+selected);
   if(gitSourceObject(output).toString('hex')!==expected.id)throw Error('Selected Git source differs from its original object: '+selected);
   receipts.push({path:selected,...expected,transportSha256:transportSha256.digest('hex'),transportBytes:size});
  }finally{fs.rmSync(archive,{force:true});}
 }
 fs.writeFileSync(destination+'.source.json',JSON.stringify({repository:record.repository,revision:record.revision,selection:receipts},null,2)+'\n',{flag:'wx'});
 return destination;
}
