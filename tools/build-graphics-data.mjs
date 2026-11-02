import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {buildGraphicsSource} from './graphics-producer.mjs';
import {sharedGraphicsFiles} from './graphics-shared-data.mjs';
import {helperPackage} from './helper-package.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Generate resources once, then compare real Universal and Intel stage inventories. */
export async function buildGraphicsData({project,version,output,work,...options}){
 const moltenvk=preparedBuildInput('graphics-moltenvk');if(!moltenvk)throw Error('Graphics data requires its prepared MoltenVK input.');
 const sourceVersion=buildRecord(resolveProject('reshade',root,{resolvePins:false})).version,universalWork=path.join(work,'universal');
 const universal=await buildGraphicsSource({...options,version:sourceVersion,arch:'universal',work:universalWork,output:path.join(work,'universal-stage'),inputs:{moltenvk:moltenvk.root}});
 // Reuse the same source-produced tools/providers. Intel staging only thins native
 // files and updates their descriptors; it does not compile another provider set.
 const reuse={core:path.join(universalWork,'core'),...universal.resolved.payloads};
 const intel=await buildGraphicsSource({...options,version:sourceVersion,arch:'x64',work:path.join(work,'x64'),output:path.join(work,'x64-stage'),inputs:{moltenvk:moltenvk.root},tools:universal.tools,reuse});
 const variants=[universal,intel].map(row=>({root:path.join(row.output,'payload'),declaration:JSON.parse(fs.readFileSync(path.join(row.output,'declaration.json')))})),files=sharedGraphicsFiles(variants);
 if(!files.length)throw Error('The source-produced graphics stages contain no shared resources.');
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 const notices=variants[0].declaration.notices,selected=new Set([...files.map(row=>row.path),...notices.map(row=>row.path)]);
 for(const relative of selected){const source=path.join(variants[0].root,relative),target=path.join(payload,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,fs.statSync(source).mode&0o777);}
 const evidence={classification:'same-path-content-mode-without-native-object',variants:variants.map(({declaration})=>({version:declaration.version,arch:declaration.arch,manifestSha256:declaration.manifestSha256,sourceSha256:declaration.sourceSha256})),sharedFiles:files.length,sharedBytes:files.reduce((sum,row)=>sum+row.size,0)},sourceSha256=crypto.createHash('sha256').update(JSON.stringify({evidence,files})).digest('hex');
 return helperPackage({id:project,version,arch:'universal',output,minimumMacOS:'13.0',sourceSha256,manifestRelative:'graphics-data.json',record:{kind:'graphics-data',...evidence,sharedInventory:files},notices});
}
recipeMain(import.meta,buildGraphicsData);
