import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {pack} from '../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url);
const B=require('../../lib/bundled-native.cjs');
const M=require('../maclauncher/src/modules/shared/runtime/macho-load-commands.js');
const here=import.meta.dirname;
const source=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file));

function verifyInputs(){
  for(const [name,expected] of Object.entries(source.ownedFiles)){
    B.relativeFile(name);
    const file=path.join(here,name);
    if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||hash(file)!==expected)throw Error('The producer input has changed: '+name);
  }
}
function copy(from,to){
  if(!fs.lstatSync(from).isFile()||fs.lstatSync(from).isSymbolicLink())throw Error('Package inputs must be ordinary files.');
  fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to,(fs.statSync(from).mode&0o111)?0o755:0o644);
}
function inventory(root){
  return B.fileInventory(root).map(name=>{
    const file=path.join(root,name),stored=B.readRegular(file,B.LIMITS.fileBytes);
    const magic=stored.bytes.length>=4?stored.bytes.readUInt32BE(0):0;
    let architectures;
    if([0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca,0xfeedfacf,0xcffaedfe].includes(magic)){
      const image=M.readMachOLoadCommands(file);M.assertSystemLibraryClosure(image,{maximumMacOS:'13.0'});
      execFileSync('/usr/bin/codesign',['--verify','--strict',file],{stdio:'pipe',timeout:30000});
      architectures=image.architectures;
    }
    return {path:name,size:stored.size,sha256:stored.sha256,mode:stored.mode,...(architectures?{architectures}:{})};
  });
}

/** Repackage verified supplied bytes with their engine-owned adaptations. */
export async function packageRuntime({project,input,output,arch='arm64'}){
  verifyInputs();
  const pin=source.projects[project];
  if(!pin||!['arm64','x64'].includes(arch)||!path.isAbsolute(input||'')||!path.isAbsolute(output||''))throw Error('Select a supported project, CPU and absolute input/output paths.');
  input=fs.realpathSync(input);
  if(fs.existsSync(output)||output===input||output.startsWith(input+path.sep))throw Error('Choose a new immutable output outside the input tree.');
  fs.mkdirSync(output,{recursive:true});
  const payload=path.join(output,'payload'),files=path.join(payload,'files');fs.mkdirSync(files,{recursive:true});
  let executableRelative,notices=[],provenance,runtimeFiles={};
  try{
    if(project==='siglus'){
      if(hash(path.join(input,'siglus-profile.json'))!==pin.inputProfileSha256)throw Error('The Siglus input profile differs from its selected publisher artifact.');
      for(const [name,expected] of Object.entries(pin.inputFiles))if(hash(path.join(input,name))!==expected)throw Error('The Siglus input has changed: '+name);
      for(const name of Object.keys(pin.inputFiles))copy(path.join(input,name),path.join(files,name));
      const profile=read(path.join(input,'siglus-profile.json'));profile.version=pin.version;
      fs.writeFileSync(path.join(files,'siglus-profile.json'),JSON.stringify(profile,null,2)+'\n',{mode:0o644,flag:'wx'});
      executableRelative='bin/siglus-host';runtimeFiles={siglusLibrary:'lib/libsiglus.dylib',siglusProfile:'siglus-profile.json'};
      notices=[{name:'siglus_rs',license:'MPL-2.0',sourceUrl:pin.upstream.url,path:'LICENSE-siglus_rs.txt'}];
      provenance={sourceRevision:pin.upstream.revision,sourceKind:'publisher-binary',verifiedBuild:false,inputProfileSha256:pin.inputProfileSha256};
    }else if(project==='krkrsdl2'){
      if(hash(path.join(input,'manifest.json'))!==pin.inputManifestSha256)throw Error('The KiriKiri input differs from its selected sealed package.');
      const original=read(path.join(input,'manifest.json'));B.validateManifest(original,{managerId:project,upstreamRevision:pin.upstream.revision,arch});
      B.verifyPayload(path.join(input,'files'),original);
      for(const file of original.files)copy(path.join(input,'files',file.path),path.join(files,file.path));
      const polyfill=read(path.join(here,'kag3-polyfill/manifest.json'));
      for(const name of [...Object.keys(polyfill.files),'manifest.json'])copy(path.join(here,'kag3-polyfill',name),path.join(files,'share/kag3-polyfill',name));
      executableRelative=original.executableRelative;provenance={...original.provenance,inputManifestSha256:pin.inputManifestSha256,kag3Revision:pin.polyfill.revision};
      notices=[...original.notices,{name:'KAG3 polyfill font',license:'See included font license',sourceUrl:pin.polyfill.url,path:'share/kag3-polyfill/FONT_LICENSE.txt'}];
      runtimeFiles={...original.runtimeFiles,kag3Manifest:'share/kag3-polyfill/manifest.json'};

    }
    const nativeFiles=inventory(files).map(file=>arch==='x64'&&file.architectures&&!file.architectures.includes('arm64')?{...file,executionArchitecture:'x86_64'}:file);
    if(nativeFiles.some(file=>file.architectures&&!file.architectures.includes(arch==='x64'?'x86_64':arch)))throw Error('The package contains a library for a different CPU.');
    const dependencies=nativeFiles.filter(file=>file.architectures).map(file=>({file:file.path,links:[...new Set(M.readMachOLoadCommands(path.join(files,file.path)).slices.flatMap(slice=>slice.dependencies.map(dependency=>dependency.path)))]}));
    const sourceSha256=hash(path.join(here,'source.json'));
    const manifest={schemaVersion:1,managerId:project,version:pin.version,upstreamRevision:pin.upstream.revision,platform:'darwin',arch,minimumMacOS:'13.0',executableRelative,files:nativeFiles,notices,dependencies,runtimeFiles,provenance:{...provenance,producerSourceSha256:sourceSha256}};
    B.validateManifest(manifest);B.verifyPayload(files,manifest);
    const manifestPath=path.join(payload,'manifest.json');fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o644,flag:'wx'});
    const launcherArchitectures=arch==='x64'?['arm64','x64']:['arm64'];
    const declaration={id:project,version:pin.version,arch,launcherArchitectures,minimumMacOS:manifest.minimumMacOS,sourceRelative:null,sourceSha256,directoryRelative:[project,pin.version,arch].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(manifestPath),files:[...nativeFiles.map(file=>({...file,path:'files/'+file.path})),{path:'manifest.json',...(({bytes,...rest})=>rest)(B.readRegular(manifestPath,B.LIMITS.manifestBytes))}],notices:notices.map(notice=>({...notice,path:'files/'+notice.path}))};
    fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
    const archive=path.join(output,`${project}-${pin.version}-${arch}.tar.gz`);
    const record=await pack({project,input:payload,declaration,output:archive});
    return {project,version:pin.version,arch,record,archive,output};
  }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

export async function main(args){
  const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['project','input','output','arch'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --input, --output and optional --arch.');options[key]=args[i+1];}
  return packageRuntime(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
