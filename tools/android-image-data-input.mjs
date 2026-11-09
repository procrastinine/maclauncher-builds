import './producer-environment.mjs';
import {aimSource} from '../lib/android-source.mjs';
import {verifyPreparedPayload} from './prepared-build-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {sha} from './helper-package.mjs';
import {imageDataContentIdentity} from './build-android-image-data.mjs';
const require=createRequire(import.meta.url),{validateDeclaration,logicalFiles}=require('../lib/package-contract.cjs');
const descriptor=new URL('../producers/android-image-data/source.json',import.meta.url);

/** Read the complete ordinary sealed input group before restoring its Mac image. */
export function readImageDataInputs(inputs){
 const profile={...JSON.parse(fs.readFileSync(descriptor)),...aimSource()};
 if(!Array.isArray(inputs)||inputs.length!==profile.profiles.length)throw Error('The complete original image input group is required.');
 const parts=[],ids=new Set(),objects=new Map();let transport,transportSha256,content;
 for(const input of inputs){
  if(!path.isAbsolute(input||''))throw Error('Image input directories must be absolute.');
  const declaration=JSON.parse(fs.readFileSync(path.join(input,'declaration.json'))),payload=path.join(input,'payload');validateDeclaration(declaration);
  const selected=profile.profiles.find(row=>row.id===declaration.id&&row.version===declaration.version);
  if(!selected||ids.has(selected.id))throw Error('Image input is not one unused declared shard.');ids.add(selected.id);
  verifyPreparedPayload(payload,declaration);
  const manifest=JSON.parse(fs.readFileSync(path.join(payload,'input.json'))),indexFile=path.join(payload,'image-data.json'),index=JSON.parse(fs.readFileSync(indexFile)),hash=sha(indexFile),identity=JSON.parse(fs.readFileSync(path.join(payload,'content.json')));
  transportSha256=hash;transport=index;content=identity;
  const shard=index.shards?.find(row=>row.id===selected.id&&row.version===selected.version);
  if(!shard)throw Error('Image input shard is not in the complete index.');
  const files=logicalFiles(declaration),inventory=new Map(files.map(file=>[file.path,file]));
  for(const object of shard.objects){
   const file=inventory.get('data/'+object.data);
   if(!/^\d{8}(?:-\d{4})?$/.test(object.data||'')||objects.has(object.data)||!file)throw Error('Image data object is missing or repeated.');
   objects.set(object.data,{...object,file:path.join(payload,'data',object.data)});
  }
  parts.push({input,payload,declaration,manifest});
 }
 if(profile.profiles.some(row=>!ids.has(row.id))||JSON.stringify(imageDataContentIdentity(transport,{targetSymlinkMode:profile.targetSymlinkMode}))!==JSON.stringify(profile.content))throw Error('Image group is incomplete or has a different target identity.');
 const expected=transport.records.filter(row=>row.kind==='file').flatMap(row=>row.chunks?.length?row.chunks:[{data:row.data,size:row.size,sha256:row.sha256}]);
 if(expected.length!==objects.size||expected.some(row=>{const file=objects.get(row.data);return !file||file.size!==row.size||file.sha256!==row.sha256;}))throw Error('Image group does not contain its complete original data.');
 return {profile,transport,content,parts,objects,transportSha256};
}

/** Assemble only verified data members; COPYFILE_FICLONE also works by copying. */
export function materializeImageDataInputs({inputs,output}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Image assembly needs a new absolute directory.');
 const root=path.resolve(output);
 if(Array.isArray(inputs)&&inputs.some(input=>typeof input==='string'&&(root===path.resolve(input)||root.startsWith(path.resolve(input)+path.sep)||path.resolve(input).startsWith(root+path.sep))))throw Error('Image assembly must be separate from sealed input directories.');
 const selected=readImageDataInputs(inputs);fs.mkdirSync(path.join(root,'data'),{recursive:true});
 try{
  for(const [name,object]of selected.objects)fs.copyFileSync(object.file,path.join(root,'data',name),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  for(const name of ['image-data.json','content.json'])fs.copyFileSync(path.join(selected.parts[0].payload,name),path.join(root,name),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  return {root,...selected};
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
}
