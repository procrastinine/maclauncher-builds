// GitHub build of an owned-source native helper from its build profile. One profile
// per helper names the sources, compiler flags, output and identity fields; this
// command compiles them for one package architecture, signs the result ad hoc and
// writes the helper record and package declaration that release preparation reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveProject} from '../lib/projects.mjs';
const require=createRequire(import.meta.url);
const B=require('../lib/bundled-native.cjs'),Native=require('../lib/local-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const root=path.resolve(import.meta.dirname,'..');
const CPUS={arm64:['arm64'],x64:['x86_64'],universal:['arm64','x86_64']};
const KINDS={executable:[],dylib:['-dynamiclib'],bundle:['-bundle']};
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe'],...options}).trim();
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contained=(value,base)=>typeof value==='string'&&!path.isAbsolute(value)&&!value.split('/').includes('..')&&path.join(base,value).startsWith(base+path.sep);

/** Profiles live next to the producer source: <sourceDirectory>/helper-builds/<project>.json. */
export function helperProfile(id,directory=root){
 const project=resolveProject(id,directory,{resolvePins:false}),producer=path.join(directory,project.producer.sourceDirectory||'');
 const file=path.join(producer,'helper-builds',id+'.json'),profile=JSON.parse(fs.readFileSync(file));
 if(profile.sourceDirectory!==undefined&&!contained(profile.sourceDirectory,directory))throw Error('Invalid helper source directory.');
 const base=profile.sourceDirectory?path.join(directory,profile.sourceDirectory):producer;
 const keys=['schemaVersion','id','version','compiler','kind','output','sources','flags','frameworks','minimumMacOS','license','record','binaryField','sourceDirectory'];
 if(!profile||profile.schemaVersion!==1||profile.id!==id||Object.keys(profile).some(key=>!keys.includes(key))||!['clang','clang++'].includes(profile.compiler)||!Object.hasOwn(KINDS,profile.kind)||
  !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile.output||'')||!Array.isArray(profile.sources)||!profile.sources.length||!profile.sources.every(source=>contained(source,base))||
  !Array.isArray(profile.flags)||profile.flags.some(flag=>typeof flag!=='string'||/^-(?:arch|isysroot|mmacosx-version-min|o$)/.test(flag))||
  profile.frameworks!==undefined&&(!Array.isArray(profile.frameworks)||!profile.frameworks.every(name=>/^[A-Za-z0-9]+$/.test(name)))||
  !/^\d+\.\d+$/.test(profile.minimumMacOS||'')||!contained(profile.license?.from,base)||!/^[A-Za-z0-9._-]+$/.test(profile.license?.path||'')||!profile.license.name||!profile.license.license||
  profile.binaryField!==undefined&&!['binarySha256','librarySha256'].includes(profile.binaryField)||
  !profile.record||typeof profile.record!=='object'||Object.keys(profile.record).some(key=>['schemaVersion','id','version','sourceSha256','binarySha256','librarySha256','minimumMacOS','architectures','build'].includes(key)))
  throw Error('Invalid helper build profile.');
 if(!(project.packageProfiles||[]).some(item=>item.version===profile.version))throw Error('The helper build profile names an undeclared version.');
 return {project,profile,base};
}

export function buildHelper({project:id,arch,output,work=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'helper-build-')),'work'),directory=root}){
 const {profile,base}=helperProfile(id,directory);
 if(!Object.hasOwn(CPUS,arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))
  throw Error('Select arm64, x64 or universal, and new absolute output and work directories.');
 const payload=path.join(output,'payload'),binary=path.join(payload,profile.output),sources=profile.sources.map(source=>path.join(base,source));
 const sdk=fs.realpathSync(process.env.SDKROOT||run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])),compiler=run('/usr/bin/xcrun',[profile.compiler,'--version']).split('\n')[0];
 const flags=[...KINDS[profile.kind],'-mmacosx-version-min='+profile.minimumMacOS,...profile.flags,...(profile.frameworks||[]).flatMap(name=>['-framework',name])];
 fs.mkdirSync(work,{recursive:true});fs.mkdirSync(payload,{recursive:true});
 try{
  // Each CPU compiles separately; a universal helper joins the slices.
  const slices=CPUS[arch].map(cpu=>{const file=path.join(work,cpu);
   run('/usr/bin/xcrun',['--sdk','macosx',profile.compiler,'-arch',cpu,'-isysroot',sdk,...flags,'-ffile-prefix-map='+directory+'=maclauncher-builds',...sources,'-o',file],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(process.env.DEVELOPER_DIR?{DEVELOPER_DIR:process.env.DEVELOPER_DIR}:{}),SDKROOT:sdk,MACOSX_DEPLOYMENT_TARGET:profile.minimumMacOS,TMPDIR:work,...Object.fromEntries(['SOURCE_DATE_EPOCH','ZERO_AR_DATE','TZ','LC_ALL','PYTHONHASHSEED'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))}});return file;});
  if(slices.length>1)run('/usr/bin/lipo',['-create',...slices,'-output',binary]);else fs.copyFileSync(slices[0],binary);
  fs.chmodSync(binary,0o755);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',binary]);run('/usr/bin/codesign',['--verify','--strict',binary]);
  const architectures=Native.readMachOArchitectures(binary,{allowLibrary:true}).sort();
  if(JSON.stringify(architectures)!==JSON.stringify(CPUS[arch]))throw Error('The helper was built for different CPUs.');
  fs.copyFileSync(path.join(base,profile.license.from),path.join(payload,profile.license.path));fs.chmodSync(path.join(payload,profile.license.path),0o644);
  // The first source is the helper's primary source; the release tag holds all of them.
  const sourceSha256=sha(sources[0]);
  const record={schemaVersion:1,id,version:profile.version,...profile.record,sourceSha256,[profile.binaryField||'binarySha256']:sha(binary),minimumMacOS:profile.minimumMacOS,architectures,
   build:{compiler,sdk:run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-version']),flags,sources:profile.sources,
    ...(flags.includes('-install_name')?{installName:flags[flags.indexOf('-install_name')+1]}:{}),signing:'ad-hoc'}};
  const metadata=Buffer.from(JSON.stringify(record,null,2)+'\n');fs.writeFileSync(path.join(payload,'helper.json'),metadata,{flag:'wx',mode:0o644});
  // An Intel executable also runs as its own process on Apple Silicon through Rosetta;
  // an Intel library loads only into an Intel process.
  const rosetta=arch==='x64'&&profile.kind==='executable';
  const files=fs.readdirSync(payload).sort().map(name=>{const file=path.join(payload,name),stat=fs.statSync(file);
   return {path:name,size:stat.size,sha256:sha(file),mode:stat.mode&0o777,...(name===profile.output?{architectures,...(rosetta?{executionArchitecture:'x86_64'}:{})}:{})};});
  const declaration={id,version:profile.version,arch,launcherArchitectures:arch==='arm64'?['arm64']:arch==='x64'&&!rosetta?['x64']:['arm64','x64'],minimumMacOS:profile.minimumMacOS,
   sourceRelative:null,sourceSha256,directoryRelative:[id,profile.version,arch].join('/'),manifestRelative:'helper.json',manifestSha256:B.digest(metadata),files,
   notices:[{name:profile.license.name,license:profile.license.license,path:profile.license.path}]};
  validateDeclaration(declaration);B.verifyPayload(payload,declaration);
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
  return {project:id,version:profile.version,arch,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
 finally{fs.rmSync(work,{recursive:true,force:true});}
}

export function main(args){
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --arch, --output and --work.');options[key]=args[i+1];}
 return buildHelper(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
