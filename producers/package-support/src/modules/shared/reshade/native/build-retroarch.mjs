import {appPath,appRequire,exportAppFile} from '../../../../../../../tools/app-source.mjs';
import {gitlink,sourceRevision} from '../../../../../../../lib/pins.mjs';
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {applyRetroarchExternalOverlay} from './retroarch-external-overlay.mjs';
const {SCENE_SHADER_INPUTS}=appRequire('src/modules/shared/effects/operation-contracts.mjs');
const [sourceArg,outputArg,...flags]=process.argv.slice(2),phaseAt=flags.indexOf('--phase'),phase=phaseAt<0?null:flags[phaseAt+1],options=phaseAt<0?flags:[...flags.slice(0,phaseAt),...flags.slice(phaseAt+2)];
const arch=options.length===1&&options[0]==='--universal'?'universal':options.length===2&&options[0]==='--arch'?options[1]:'arm64';
if(!sourceArg||!outputArg||!['arm64','x64','universal'].includes(arch)||options.length&&!((options.length===1&&options[0]==='--universal')||(options.length===2&&options[0]==='--arch')))
  throw new Error('Usage: node build-retroarch.mjs <original librashader source> <new output> [--universal] [--phase compile|assemble]');
if(phaseAt>=0&&!['compile','assemble'].includes(phase))throw new Error('Choose the compile or assemble phase.');
const originalSource=path.resolve(sourceArg),output=path.resolve(outputArg);
const native='src/modules/shared/reshade/native';
const declaration=JSON.parse(fs.readFileSync(new URL('./retroarch-source.json',import.meta.url)));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:180000,...options});
const source=path.join(output,'upstream-source');
/** Build librashader and the preparation helper from the overlaid upstream source. */
function compile(){
 if(fs.existsSync(output))throw new Error('Use a new RetroArch shader output directory.');
 fs.mkdirSync(output,{recursive:true});
 const sourceArchive=path.join(output,'upstream.tar');
 run('git',['-C',originalSource,'archive','--format=tar','--output',sourceArchive,sourceRevision(declaration)]);
 fs.mkdirSync(source);run('/usr/bin/tar',['-xf',sourceArchive,'-C',source]);fs.unlinkSync(sourceArchive);
 applyRetroarchExternalOverlay(source);
 const library=path.join(output,'librashader.dylib');
 const project=path.join(output,'prepare-source');fs.mkdirSync(project);
 for(const name of ['main.rs','Cargo.lock'])exportAppFile(native+'/retroarch-prepare/'+name,path.join(project,name));
 const manifest=fs.readFileSync(appPath(native+'/retroarch-prepare/Cargo.toml'),'utf8');
 fs.writeFileSync(path.join(project,'Cargo.toml'),manifest.replaceAll('../../../../../external/librashader',source));
 const env={...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0',CFLAGS:[process.env.CFLAGS||'','-ffile-prefix-map='+os.homedir()+'=BuildHome -ffile-prefix-map='+output+'=retroarch-build'].join(' '),CXXFLAGS:[process.env.CXXFLAGS||'','-ffile-prefix-map='+os.homedir()+'=BuildHome -ffile-prefix-map='+output+'=retroarch-build'].join(' '),RUSTFLAGS:[process.env.RUSTFLAGS||'', '--remap-path-prefix='+os.homedir()+'=BuildHome','--remap-path-prefix='+source+'=librashader','--remap-path-prefix='+project+'=retroarch-prepare','--remap-path-prefix='+output+'=retroarch-build'].join(' ')};
 const capiTarget=path.join(output,'capi-target'),helperTarget=path.join(output,'target');
 const targets=arch==='universal'?['aarch64-apple-darwin','x86_64-apple-darwin']:[arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin'];
 const cargo=process.env.CARGO||'cargo';
 // Public builds fetch the dependencies described by the existing exact locks;
 // compilation then uses the same offline dependency set on each CPU.
 for(const manifest of [path.join(source,'Cargo.toml'),path.join(project,'Cargo.toml')])run(cargo,['fetch','--locked','--manifest-path',manifest],{env,timeout:900000});
 const libraries=[],helpers=[];
 for(const target of targets){
  run(cargo,['build','--release','--locked','--offline','--target',target,'--no-default-features','--features','runtime-metal','--package','librashader-capi','--manifest-path',path.join(source,'Cargo.toml'),'--target-dir',capiTarget,'--jobs','6'],{env,timeout:900000});
  libraries.push(path.join(capiTarget,target,'release/liblibrashader_capi.dylib'));
  run(cargo,['build','--release','--locked','--offline','--target',target,'--manifest-path',path.join(project,'Cargo.toml'),'--target-dir',helperTarget,'--jobs','6'],{env,timeout:900000});
  helpers.push(path.join(helperTarget,target,'release/retroarch-prepare'));
 }
 const helper=path.join(output,'retroarch-prepare');
 for(const [inputs,target] of [[libraries,library],[helpers,helper]]){
  if(inputs.length>1)run('/usr/bin/lipo',['-create',...inputs,'-output',target]);else fs.copyFileSync(inputs[0],target);
  fs.chmodSync(target,0o755);
 }
 run('/usr/bin/install_name_tool',['-id','@rpath/librashader.dylib',library]);
 for(const file of [library,helper]){run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);}
}
/** Add the notices and describe the compiled files. */
function assemble(){
 addLicenses(output,'librashader',originalSource);
 fs.writeFileSync(path.join(output,'source.json'),JSON.stringify(declaration,null,2)+'\n');
 const files=fs.readdirSync(output).filter(name=>!['upstream-source','prepare-source','target','capi-target'].includes(name)).flatMap(name=>{const file=path.join(output,name);return fs.statSync(file).isDirectory()?fs.readdirSync(file,{recursive:true}).map(relative=>path.join(file,relative)).filter(file=>fs.statSync(file).isFile()):[file];}).map(file=>({path:path.relative(output,file),source:file,size:fs.statSync(file).size,mode:fs.statSync(file).mode&0o777,sha256:hash(file)}));
 fs.writeFileSync(path.join(output,'runtime-files.json'),JSON.stringify({sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS],uniformSnapshotsAPI:1,uniformSnapshotCapacityAPI:1,files},null,2)+'\n');
 console.log(JSON.stringify({output,files}));
}
if(phase!=='assemble')compile();
if(phase!=='compile')assemble();
