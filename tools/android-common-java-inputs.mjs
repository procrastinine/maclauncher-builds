import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyAndroidJavaConverterInput} from './build-android-java-converter.mjs';
import {verifyAndroidJavaFrameworkInput} from './build-android-java-framework.mjs';
import {run} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8'}).trim();

/** Add only the declared Java-product transport to an owned export of its original compiler. */
export function prepareAndroidCommonJavaProducer({android,input,framework,output}){
 const inputs=[...(input?[verifyAndroidJavaConverterInput(input)]:[]),...(framework?[verifyAndroidJavaFrameworkInput(framework)]:[])];
 if(!inputs.length)throw Error('At least one declared Java input is required.');const verified=inputs[0];
 if(inputs.some(value=>value.manifest.androidSource.revision!==verified.manifest.androidSource.revision))throw Error('Java inputs select different Android producers.');
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||read(android,['rev-parse','HEAD'])!==verified.manifest.androidSource.revision||read(android,['status','--porcelain','--untracked-files=no']))throw Error('Java composition needs its exact immutable Android producer and a new export directory.');
 const archive=output+'.tar';fs.mkdirSync(output,{recursive:true});
 try{
  run('git',['-C',android,'archive','--format=tar','--output='+archive,'HEAD']);
  run('/usr/bin/tar',['-xf',archive,'-C',output]);
  run('git',['apply',path.join(root,'producers/android-inputs/java-converter-consumer.patch')],{cwd:output,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(output)}});
  if(framework){
   run('git',['apply',path.join(root,'producers/android-inputs/java-framework-consumer.patch')],{cwd:output,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(output)}});
   fs.copyFileSync(path.join(root,'producers/android-inputs/java-framework-consumer.mjs'),path.join(output,'src/modules/android/native/java-framework-input.mjs'));
  }
  return output;
 }finally{fs.rmSync(archive,{force:true});}
}
