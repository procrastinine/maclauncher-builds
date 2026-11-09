import {sourceRevision} from '../lib/pins.mjs';
import './producer-environment.mjs';
import {androidSource,androidSourceJson} from '../lib/android-source.mjs';
import {includeLicenses,addLicenses,addLicense} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {helperPackage,sha} from './helper-package.mjs';

const root=path.resolve(import.meta.dirname,'..');
const descriptor=path.join(root,'producers/android-inputs/angle.json');
export function angleDefinition(){const definition=JSON.parse(fs.readFileSync(descriptor));return {...definition,angle:androidSourceJson(definition.angleSource),pythonVersion:JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/aim.json'))).pythonVersion};}
const read=(command,args,options={})=>execFileSync(command,args,{maxBuffer:Infinity,encoding:'utf8',...options}).trim();

function selectedProfile(value,kind='id'){
 const definition=angleDefinition(),profile=definition.profiles.find(row=>row[kind]===value);
 if(!profile)throw Error('Select a declared Android ANGLE input profile.');
 return {definition,profile};
}
export function anglePackageProfile(project,version){
 const definition=angleDefinition();
 let matches=definition.profiles.filter(profile=>project===(profile.project||definition.id)&&version===(profile.packageVersion||profile.version));
 if(!matches.length&&project===definition.id)matches=definition.profiles.filter(profile=>version===profile.version);
 if(matches.length!==1)throw Error('Select an ANGLE package and its declared source profile.');
 return {definition,profile:matches[0]};
}
function verifyProducerSource(source,profile){
 if(!path.isAbsolute(source||'')||read('git',['-C',source,'rev-parse','HEAD'])!==androidSource().revision||read('git',['-C',source,'status','--porcelain','--untracked-files=no']))throw Error('Android producer differs from its declared source revision.');
}

/** Build the selected common or AIM ANGLE supplier from its exact owned sources. */
export async function buildAngleInput({output,work,profile:profileId='common'}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('ANGLE input builds require Apple Silicon macOS and new absolute output/work directories.');
 const {definition,profile}=selectedProfile(profileId);
 fs.mkdirSync(work,{recursive:true});
 const android=path.join(root,androidSource().directory);
 verifyProducerSource(android,profile);
 const pins=definition.angle,entry=path.join(android,'src/modules/android/native/angle-build.mjs');

 const upstream=checkoutSource({repository:pins.repository,revision:pins.revision,destination:path.join(work,'angle')});
 const dependencies=path.join(work,'dependencies');fs.mkdirSync(dependencies);
 for(const dependency of pins.dependencies.filter(item=>!item.backends||item.backends.includes(definition.backend)))checkoutSource({repository:dependency.url,revision:sourceRevision(dependency),destination:path.join(dependencies,path.basename(dependency.directory))});
 const gnSource=checkoutSource({...definition.gn,destination:path.join(work,'gn-source')});
 const pythonRoot=path.join(work,'python');
 const pythonEnv={...process.env,UV_CACHE_DIR:path.join(work,'uv-cache'),UV_PYTHON_INSTALL_DIR:pythonRoot,UV_PYTHON_BIN_DIR:path.join(work,'python-bin')};
 run('uv',['python','install',definition.pythonVersion],{env:pythonEnv});
 const python=read('uv',['python','find','--managed-python','--system',definition.pythonVersion],{env:pythonEnv});
 if(!fs.realpathSync(python).startsWith(fs.realpathSync(pythonRoot)+path.sep))throw Error('The selected Python interpreter is outside the declared build input directory.');
 const gnBuild=path.join(work,'gn-build');fs.mkdirSync(gnBuild);
 // GN's source build accepts an externally supplied version header. The position
 // and revision are from the exact ANGLE DEPS GN pin, independently of clone depth.
 fs.writeFileSync(path.join(gnBuild,'last_commit_position.h'),`#define LAST_COMMIT_POSITION_NUM ${definition.gn.commitPosition}\n#define LAST_COMMIT_POSITION "${definition.gn.commitPosition} (${sourceRevision(definition.gn).slice(0,12)})"\n`);
 const compilerEnv={...process.env,SDKROOT:process.env.SDKROOT||read('xcrun',['--sdk','macosx','--show-sdk-path'])};
 run(python,[path.join(gnSource,'build/gen.py'),'--no-last-commit-position','--allow-warnings','--out-path='+gnBuild],{env:compilerEnv});
 run('ninja',['-C',gnBuild,'-j2','gn'],{env:compilerEnv});
 const clang=path.dirname(path.dirname(read('xcrun',['--find','clang'])));
 const toolEnv={...compilerEnv,PATH:path.dirname(python)+path.delimiter+process.env.PATH};
 run(process.execPath,[entry,'--source',upstream,'--dependencies',dependencies,'--output',output,'--gn',path.join(gnBuild,'gn'),'--ninja',read('which',['ninja']),'--clang',clang,'--python',python,'--backend',definition.backend,'--jobs','2'],{env:toolEnv});
 addLicenses(output,'ANGLE',upstream);
 for(const dependency of pins.dependencies.filter(item=>!item.backends||item.backends.includes(definition.backend)))addLicenses(output,dependency.name,path.join(dependencies,path.basename(dependency.directory)));
 addLicense(output,'Khronos headers',path.join(root,'producers/android-inputs/licenses/angle/Khronos-Headers.txt'));
 addLicense(output,'libc++',path.join(root,'producers/android-inputs/licenses/angle/libcxx.txt'));
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'angle-manifest.json')));
 if(manifest.version!==profile.providerVersion||manifest.angleRevision!==pins.revision)throw Error('Generated ANGLE profile differs from its declared identity.');
 return {angle:output,manifest,source:android,profileId};
}

/** Package unchanged compiler products with the selected normal package version. */
export function packageAngleInput({project='android-angle',version,arch='arm64',output,input}){
 const {definition,profile}=anglePackageProfile(project,version);
 if(arch!=='arm64'||!path.isAbsolute(output||'')||fs.existsSync(output)||input?.profileId!==profile.id)throw Error('Select the declared ANGLE package version, matching source profile and a new absolute output directory.');
 verifyProducerSource(input.source,profile);
 const manifest=JSON.parse(fs.readFileSync(path.join(input.angle,'angle-manifest.json')));
 if(manifest.version!==profile.providerVersion||manifest.angleRevision!==sourceRevision(definition.angle)||!Array.isArray(manifest.adaptations))throw Error('ANGLE provider identity differs from the package source profile.');
 for(const adaptation of manifest.adaptations){
  if(path.basename(adaptation.file)!==adaptation.file)throw Error('ANGLE owned adaptation differs from the selected source profile.');
 }
 for(const file of manifest.files){
  if(path.basename(file.path)!==file.path||sha(path.join(input.angle,file.path))!==file.sha256||fs.statSync(path.join(input.angle,file.path)).size!==file.size)throw Error('ANGLE compiler product differs from its provider manifest.');
 }
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 for(const name of ['libEGL.dylib','libGLESv2.dylib','angle-manifest.json'])fs.copyFileSync(path.join(input.angle,name),path.join(payload,name));

 includeLicenses(payload,path.join(input.angle,'licenses'));
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{source:androidSource(),sourceProfile:profile.id,providerVersion:manifest.version,angleRevision:manifest.angleRevision}});
}

/** Use the one Runtime build path for each declared source profile. */
export async function buildAndroidAngle({project,version,arch,output,work}){
 const {definition,profile}=anglePackageProfile(project,version??JSON.parse(fs.readFileSync(descriptor)).profiles[0].version);
 if(!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select an Android ANGLE version, arm64 and new absolute output/work directories.');
 const input=await buildAngleInput({output:path.join(work,'provider'),work:path.join(work,'compile'),profile:profile.id});
 return packageAngleInput({project,version:version??profile.packageVersion??profile.version,arch,output,input});
}
recipeMain(import.meta,buildAndroidAngle);
