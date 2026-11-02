import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Read native object identity without a compiler or filename-based classification. */
function nativeFile(file){const header=Buffer.alloc(32),fd=fs.openSync(file,'r');let size;try{size=fs.readSync(fd,header,0,header.length,0);}finally{fs.closeSync(fd);}if(size<8)return false;const magic=header.subarray(0,4).toString('hex');if(['feedface','feedfacf','cefaedfe','cffaedfe'].includes(magic))return true;if(['cafebabe','cafebabf','bebafeca','bfbafeca'].includes(magic)){const little=magic==='bebafeca'||magic==='bfbafeca',count=little?header.readUInt32LE(4):header.readUInt32BE(4),cpu=size>=12?(little?header.readUInt32LE(8):header.readUInt32BE(8)):0;return count>0&&count<16&&[7,12,0x1000007,0x100000c].includes(cpu);}return false;}
/** Select from actual sealed CPU inventories, retaining no separate filename list. */
export function sharedGraphicsInventory(declarations){
 if(!Array.isArray(declarations)||declarations.length<2)throw Error('Shared graphics data needs at least two CPU inventories.');
 const indexes=declarations.map(declaration=>new Map(declaration.files.map(row=>[row.path,row]))),notices=new Set(declarations.flatMap(declaration=>(declaration.notices||[]).map(row=>row.path))),files=[];
 for(const first of declarations[0].files){
  if(notices.has(first.path)||declarations.some(declaration=>[declaration.manifestRelative,declaration.sourceRelative].includes(first.path)))continue;
  const records=indexes.map(index=>index.get(first.path));if(records.some(row=>!row||(row.architectures?.length&&row.format!=='pe')||row.format!==first.format||row.sha256!==first.sha256||row.size!==first.size||row.mode!==first.mode))continue;
  files.push({...first});
 }
 return files.sort((a,b)=>a.path.localeCompare(b.path));
}
/** Check the selected stored bytes before a shared data package copies them. */
export function sharedGraphicsFiles(variants){
 return sharedGraphicsInventory(variants.map(variant=>variant.declaration)).filter(row=>{
  const files=variants.map(({root})=>path.join(root,row.path));if(files.some(file=>!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||nativeFile(file)))return false;
  if(files.some(file=>fs.statSync(file).size!==row.size||hash(file)!==row.sha256))throw Error('A staged graphics resource differs from its sealed inventory: '+row.path);
  return true;
 });
}
