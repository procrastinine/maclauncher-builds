import fs from 'node:fs';
import path from 'node:path';
import {recipeMain,run} from './build-source.mjs';
import {githubBuildInput} from './github-build-input.mjs';
import {buildInput} from './build-input.mjs';
import {buildImageDataTool,packageImageData} from './build-android-image-data.mjs';
import {buildAndroidArtJavaInput} from './android-art-java-stage.mjs';
const root=path.resolve(import.meta.dirname,'..');
const json=file=>JSON.parse(fs.readFileSync(file));

/** Build original ART DEX from the signed Java framework and one portable source-image decode. */
export async function buildAndroidArtJava({project,version,arch,output,work}){
 const profile=json(path.join(root,'producers/android-art-inputs/java-stage.json'));version??=profile.version;
 if(project!==profile.id||version!==profile.version)throw Error('Select the declared ART Java input profile.');
 fs.mkdirSync(work,{recursive:true});const owned=path.resolve(work),child=name=>path.join(owned,name),retire=name=>{const selected=child(name);if(!selected.startsWith(owned+path.sep))throw Error('ART Java work leaves its owned directory.');fs.rmSync(selected,{recursive:true,force:true});};
 const framework=await githubBuildInput({pin:profile.frameworkArtifact,output:child('framework-input'),work:child('framework-download')});retire('framework-download');
 const imageProfile=json(path.join(root,profile.imageInput)),imageWork=child('image-work');fs.mkdirSync(imageWork);
 const archive=await buildInput(imageProfile.archive,path.join(imageWork,'archive-cache')),tool=buildImageDataTool({work:imageWork}),decoded=path.join(imageWork,'decoded');
 run(tool.executable,['export',archive,path.join(imageWork,'root'),decoded],{env:tool.env});
 // The authenticated portable objects own all subsequent image reads.
 for(const name of ['root','archive-cache'])fs.rmSync(path.join(imageWork,name),{recursive:true,force:true});
 const image=[];
 for(const id of profile.imageProfiles){
  const selected=imageProfile.profiles.find(selected=>selected.id===id);if(!selected)throw Error('The required original image shard profile is unavailable.');
  const destination=child(id);await packageImageData({project:id,version:selected.version,arch,output:destination,work:imageWork,tool,input:decoded});image.push(path.join(destination,'payload'));
 }
 retire('image-work');
 const result=await buildAndroidArtJavaInput({framework:framework.root,image,output,work:child('java-work'),arch});
 retire('framework-input');for(const id of profile.imageProfiles)retire(id);retire('java-work');return result;
}
recipeMain(import.meta,buildAndroidArtJava);
