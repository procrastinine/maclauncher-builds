import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {buildOptions} from './build-source.mjs';
import {managerDeclaration} from './release-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit',env:{...process.env,SDKROOT:process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim()}});
export async function buildMKXPZ({project,arch,output,work}){
 if(project!=='mkxpz'||arch!=='arm64'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select MKXP-Z arm64 and new absolute work/output paths.');
 fs.mkdirSync(work,{recursive:true});
 const pin=JSON.parse(fs.readFileSync(path.join(root,'runtimes/mkxpz/baseline.json'))).upstream;
 const archive=await buildInput({url:pin.sourceUrl,sha256:pin.sourceSha256,bytes:pin.sourceBytes},path.join(work,'downloads'));
 const environment=path.join(work,'tools');run('uv',['venv','--python','3.13',environment]);
 run('uv',['pip','install','--python',path.join(environment,'bin/python'),'--no-deps','--requirement',path.join(root,'producers/maclauncher/scripts/graphics-build-requirements.txt')]);
 const producer=require('../producers/maclauncher/scripts/build-mkxpz-nfc.cjs'),buildWork=path.join(work,'mkxpz'),staged=path.join(work,'staged');
 const inputs=JSON.parse(fs.readFileSync(path.join(root,'producers/maclauncher/helper-builds/mkxpz.json')));
 const source=producer.prepareSource(archive,buildWork),wrap=path.join(source,inputs.sdlImage.wrap),original=fs.readFileSync(wrap,'utf8');
 const expected='revision = '+inputs.sdlImage.upstreamWrapRevision;
 if(!original.includes(expected)||!original.includes('url = '+inputs.sdlImage.repository+'\n'))throw Error('The declared SDL_image source wrap changed.');
 fs.writeFileSync(wrap,original.replace(expected,'revision = '+inputs.sdlImage.revision));
 run(process.execPath,[path.join(root,'producers/maclauncher/scripts/build-mkxpz-nfc.cjs'),'--archive',archive,'--work',buildWork,'--meson',path.join(environment,'bin/meson'),'--ninja',path.join(environment,'bin/ninja'),'--output',staged]);
 const result=JSON.parse(fs.readFileSync(path.join(buildWork,'STAGED.json'))),sdlImage=path.join(source,'subprojects/sdl2_image');
 const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'}}).trim();
 if(git(sdlImage,['rev-parse','HEAD'])!==inputs.sdlImage.revision)throw Error('SDL_image differs from its declared commit.');
 const dependencies=[{path:'sdl2_image',revision:inputs.sdlImage.revision,repository:inputs.sdlImage.repository}];
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
 return {project,version:producer.VERSION,arch,output};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildMKXPZ(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
