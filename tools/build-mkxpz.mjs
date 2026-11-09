import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {gitlink} from '../lib/pins.mjs';
import {recipeMain} from './build-source.mjs';
import {managerDeclaration} from './manager-declaration.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const run=(command,args)=>execFileSync(command,args,{maxBuffer:Infinity,stdio:'inherit',env:{...process.env,SDKROOT:process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{maxBuffer:Infinity,encoding:'utf8'}).trim()}});
export async function buildMKXPZ({project,version,arch,output,work}){
 version=buildRecord(resolveProject(project,root,{resolvePins:false}),version).version;
 fs.mkdirSync(work,{recursive:true});
 const pin=JSON.parse(fs.readFileSync(path.join(root,'runtimes/mkxpz/baseline.json'))).upstream;
 const archive=await buildInput({url:pin.repository.replace('https://github.com/','https://codeload.github.com/')+'/tar.gz/'+gitlink('producers/package-support/src/external/mkxp-z'),sha256:pin.sourceSha256,bytes:pin.sourceBytes},path.join(work,'downloads'));
 const environment=path.join(work,'tools');run('uv',['venv','--python','3.13',environment]);
 run('uv',['pip','install','--python',path.join(environment,'bin/python'),'--no-deps','--requirement',path.join(root,'producers/package-support/scripts/graphics-build-requirements.txt')]);
 const producer=require('../producers/package-support/scripts/build-mkxpz-nfc.cjs'),buildWork=path.join(work,'mkxpz'),staged=path.join(work,'staged');
 const inputs=JSON.parse(fs.readFileSync(path.join(root,'producers/package-support/helper-builds/mkxpz.json'))),sdlImagePin=inputs.sdlImage;
 const source=producer.prepareSource(archive,buildWork),wrap=path.join(source,inputs.sdlImage.wrap),original=fs.readFileSync(wrap,'utf8');
 const expected='revision = '+inputs.sdlImage.upstreamWrapRevision;
 if(!original.includes(expected)||!original.includes('url = '+sdlImagePin.repository+'\n'))throw Error('The declared SDL_image source wrap changed.');
 fs.writeFileSync(wrap,original.replace(expected,'revision = '+sdlImagePin.revision).replace(/diff_files =[^]*$/,'diff_files = maclauncher-sdl2-image.patch\n'));
 fs.copyFileSync(new URL('../producers/package-support/src/modules/rgss/overlays/mkxpz-filename-nfc/sdl2-image.patch',import.meta.url),path.join(source,'subprojects/packagefiles/maclauncher-sdl2-image.patch'));
 const imageBuild=path.join(source,'src/meson.build');
 fs.writeFileSync(imageBuild,fs.readFileSync(imageBuild,'utf8').replaceAll(".dependency('brotlicommon-static')",".dependency('brotlicommon')").replaceAll(".dependency('brotlidec-static')",".dependency('brotlidec')"));
 run(process.execPath,[path.join(root,'producers/package-support/scripts/build-mkxpz-nfc.cjs'),'--version',version,'--archive',archive,'--work',buildWork,'--meson',path.join(environment,'bin/meson'),'--ninja',path.join(environment,'bin/ninja'),'--output',staged]);
 const result=JSON.parse(fs.readFileSync(path.join(buildWork,'STAGED.json'))),sdlImage=path.join(source,'subprojects/sdl2_image');
 const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{maxBuffer:Infinity,encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'}}).trim();
 const dependencies=[{path:'sdl2_image',revision:sdlImagePin.revision,repository:sdlImagePin.repository}];
 for(const line of git(sdlImage,['submodule','status','--recursive']).split('\n').filter(Boolean)){
  const match=/^ ([a-f0-9]{40}) (\S+)/.exec(' '+line.trim());
  if(!match)throw Error('SDL_image has an uninitialized or changed dependency.');
  const repository=git(path.join(sdlImage,match[2]),['remote','get-url','origin']);
  if(!/^https:\/\//.test(repository))throw Error('SDL_image dependency needs a public HTTPS origin.');
  dependencies.push({path:'sdl2_image/'+match[2],revision:match[1],repository});
 }
 const manifestFile=path.join(result.directory,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
 manifest.provenance={...manifest.provenance,gitDependencies:dependencies};
 fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 const declaration=await managerDeclaration({project,input:result.directory});
 // Corresponding source is the recipe commit and its declared upstream inputs.
 // The producer's additional source archive remains outside the runtime payload.
 fs.mkdirSync(output);fs.cpSync(result.directory,path.join(output,'payload'),{recursive:true});
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {project,version:declaration.version,arch,output};
}
recipeMain(import.meta,buildMKXPZ);
