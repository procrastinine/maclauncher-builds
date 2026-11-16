import {wineHost} from '../../../../../../../tools/wine-host.mjs';
import {appPath,appRequire,moduleFile} from '../../../../../../../tools/app-source.mjs';
import {addLicense,addLicenses} from '../../../../../../../lib/licenses.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {source,applyProfile,sharedHeaderInputs} from './overlay.mjs';
import {prepareSourceTree,writeChanged} from '../../../shared/vulkan/native/source-files.mjs';
const here=import.meta.dirname,app=appPath('src/modules/crossover/temporal/vulkan');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer: Infinity,...options}).trim();
// A nice19 parent must not receive a second relative priority adjustment.
function runMake(args,options={}){
    const priority=read('ps',['-o','nice=','-p',String(process.pid)]);
    if(priority==='19')return run('make',args,options);
    if(priority==='0')return run('/usr/bin/nice',['-n','19','make',...args],options);
    throw Error('Wine make parent priority '+priority+', expected 0 or 19.');
}
async function verifyArchive(file,description){
    file=fs.realpathSync(file);const hash=crypto.createHash('sha256');
    for await(const bytes of fs.createReadStream(file))hash.update(bytes);
    if(hash.digest('hex')!==description.sha256 || description.bytes&&fs.statSync(file).size!==description.bytes)
        throw Error('The source archive differs from its public digest: '+description.url);
    return file;
}
export function sourceProfile(arch='x64'){
    const selected=source.hostProfiles?.[wineHost(arch).arch];
    return selected?JSON.parse(fs.readFileSync(path.join(here,selected),'utf8')):source;
}
export function checkSources(profile=source){
    const owned=Object.fromEntries(profile.ownedFiles.map(file=>[file,digest(fs.readFileSync(moduleFile('src/modules/crossover/temporal/vulkan/'+file)))]));
    const shared=Object.fromEntries([...sharedHeaderInputs(profile)].map(([file,bytes])=>[file,digest(bytes)]));
    return {profile:profile.profile,version:profile.version,source:profile.archive,owned,shared};
}
export async function prepareSource({archive,work,profile=source}){
    archive=await verifyArchive(archive,profile.archive);work=path.resolve(work);
    const identity={...checkSources(profile),profile},key=digest(Buffer.from(JSON.stringify(identity))),receipt=path.join(work,'source-inputs.json'),directory=path.join(work,'source');
    if(fs.existsSync(receipt)&&fs.existsSync(directory)){
        const previous=JSON.parse(fs.readFileSync(receipt));
        if(previous.key===key&&previous.files.every(row=>fs.existsSync(path.join(directory,row.path))&&digest(fs.readFileSync(path.join(directory,row.path)))===row.sha256))
            return {directory,key,identity,profile,reused:true};
    }
    fs.mkdirSync(work,{recursive:true});let adaptation;
    prepareSourceTree(directory,temporary=>{
        run('/usr/bin/tar',['-xzf',archive,'--no-same-owner','--strip-components='+String(profile.archive.stripComponents??2),'-C',temporary,profile.archive.directory]);
        adaptation=applyProfile(temporary,profile);
    });
    const files=adaptation.files.map(file=>({path:file,sha256:digest(fs.readFileSync(path.join(directory,file)))}));
    writeChanged(receipt,JSON.stringify({key,identity,files},null,2)+'\n');
    return {directory,key,identity,profile,reused:false};
}
async function buildBison({archive,work,jobs}){
    const tool=source.buildTools.bison;archive=await verifyArchive(archive,tool);
    const root=path.join(work,'bison'),sourceDir=path.join(root,'source'),build=path.join(root,'build'),prefix=path.join(root,'output'),executable=path.join(prefix,'bin/bison');
    if(fs.existsSync(executable)&&read(executable,['--version']).startsWith('bison (GNU Bison) '+tool.version))return executable;
    if(!fs.existsSync(sourceDir)){fs.mkdirSync(sourceDir,{recursive:true});run('/usr/bin/tar',['-xf',archive,'--no-same-owner','--strip-components=1','-C',sourceDir,tool.directory]);}
    fs.mkdirSync(build,{recursive:true});
    if(!fs.existsSync(path.join(build,'Makefile')))run('/bin/sh',[path.join(sourceDir,'configure'),'--prefix='+prefix,'--disable-nls'],{cwd:build});
    runMake(['-j'+jobs],{cwd:build});
    runMake(['install'],{cwd:build});
    if(!read(executable,['--version']).startsWith('bison (GNU Bison) '+tool.version))throw Error('The declared Bison tool did not build.');
    return executable;
}
async function prepareVulkanLink({moltenvkArchive,vulkanLibrary,work,arch}){
    const input=source.vulkanLinkInput;
    if(moltenvkArchive){
        const archive=await verifyArchive(moltenvkArchive,input.archive);
        const directory=path.join(work,'inputs','moltenvk');
        fs.mkdirSync(directory,{recursive:true});
        run('/usr/bin/tar',['-xf',archive,'--no-same-owner','-C',directory,input.file]);
        vulkanLibrary=path.join(directory,input.file);
    }
    if(!vulkanLibrary)throw Error('The declared MoltenVK archive or exact library is required.');
    vulkanLibrary=fs.realpathSync(vulkanLibrary);
    const sha256=digest(fs.readFileSync(vulkanLibrary));
    // A library from the verified archive is fixed by the archive digest; a supplied library is checked once here.
    if(!moltenvkArchive&&sha256!==input.sha256)throw Error('The Vulkan link input differs from the declared MoltenVK release.');
    run('/usr/bin/lipo',[vulkanLibrary,'-verify_arch',wineHost(arch).macho]);
    return {library:vulkanLibrary,sha256};
}
export async function buildModule(options){
    const host=wineHost(options.arch);
    const work=path.resolve(options.work),jobs=Number(options.jobs||2);
    if(!Number.isInteger(jobs)||jobs<1||jobs>2)throw Error('Use one or two compiler jobs.');
    if(/\s/.test(work))throw Error('The Wine Makefile requires a build directory without whitespace.');
    const prepared=options.prepared||await prepareSource({archive:options.archive,work,profile:options.profile});
    if(options.prepareOnly)return prepared;
    const profile=prepared.profile||source,minimumMacOS=profile.minimumMacOS;
    const peArchitectures=options.hostOnly?[]:profile.architectures.pe;
    const mingw=fs.realpathSync(options.mingw),build=path.join(work,'build-'+host.arch),vulkan=await prepareVulkanLink({...options,work});
    for(const name of peArchitectures.map(arch=>({i386:'i686',aarch64:'aarch64',arm64ec:'arm64ec',x86_64:'x86_64'}[arch]||arch)+'-w64-mingw32-clang'))fs.accessSync(path.join(mingw,name),fs.constants.X_OK);
    const bison=options.bison?fs.realpathSync(options.bison):options.bisonArchive?await buildBison({archive:options.bisonArchive,work,jobs}):'bison';
    const cc=read('xcrun',['--find','clang']),sdk=process.env.SDKROOT||read('xcrun',['--sdk','macosx','--show-sdk-path']);
    const wrapper=path.join(work,'clang-'+host.arch),linkDirectory=path.join(work,'vulkan-link');
    writeChanged(wrapper,`#!/bin/sh
current=$(ps -o nice= -p $$ | tr -d " ")
if [ "$current" = 0 ]; then
    exec /usr/bin/nice -n 19 "$0" "$@"
fi
[ "$current" = 19 ] || { echo "Wine compiler priority $current, expected 19" >&2; exit 76; }
exec ${[cc,'-arch',host.macho,'-isysroot',sdk,'-mmacosx-version-min='+minimumMacOS].map(quote).join(' ')} "$@"
`,0o755);
    writeChanged(path.join(linkDirectory,'libMoltenVK.dylib'),fs.readFileSync(vulkan.library));
    const environment={...process.env,PATH:mingw+path.delimiter+path.dirname(bison)+path.delimiter+process.env.PATH,
        CC:wrapper,
        SDKROOT:sdk,MACOSX_DEPLOYMENT_TARGET:minimumMacOS,
        CFLAGS:'-O2',CPPFLAGS:'',LDFLAGS:'-L'+linkDirectory,BISON:bison};
    fs.mkdirSync(build,{recursive:true});
    const configured=path.join(build,'configuration.json'),environmentKey=digest(Buffer.from(JSON.stringify({CC:environment.CC,LDFLAGS:environment.LDFLAGS,bison,mingw,sdk,vulkan: vulkan.sha256}))),configureKey=digest(Buffer.from(JSON.stringify({source:prepared.key,environmentKey})));
    if(!fs.existsSync(configured)||JSON.parse(fs.readFileSync(configured)).key!==configureKey){
        if(fs.existsSync(path.join(build,'config.cache'))&&(!fs.existsSync(configured)||JSON.parse(fs.readFileSync(configured)).environmentKey!==environmentKey))fs.unlinkSync(path.join(build,'config.cache'));
        const configureArgs=[path.join(prepared.directory,'configure'),'--host='+(host.arch==='arm64'?'aarch64':'x86_64')+'-apple-darwin','--enable-archs='+(peArchitectures.length?peArchitectures.join(','):'none'),'--disable-tests','--without-x','--without-freetype','--cache-file=config.cache'];
        run(host.arch==='x64'?'/usr/bin/arch':'/bin/sh',host.arch==='x64'?['-x86_64','/bin/sh',...configureArgs]:configureArgs,{cwd:build,env:environment});
        writeChanged(configured,JSON.stringify({key:configureKey,source:prepared.key,environmentKey,vulkan:{name:source.vulkanLinkInput.library,sha256:vulkan.sha256,archive:source.vulkanLinkInput.archive}},null,2)+'\n');
    }
    if(options.configureOnly)return {...prepared,build};
    const flags='-g -O2 '+[work,fs.realpathSync(work),prepared.directory,fs.realpathSync(prepared.directory)].map(root=>'-ffile-prefix-map='+root+'=WineSource').join(' '),flagFile=path.join(build,'module-compiler-flags.txt');
    if(!fs.existsSync(flagFile)||fs.readFileSync(flagFile,'utf8')!==flags+'\n')
        runMake(['dlls/winevulkan/clean'],{cwd:build,env:environment});
    const makefile=fs.readFileSync(path.join(build,'Makefile'),'utf8');
    const peLinkerFlags=Object.fromEntries(peArchitectures.map(architecture=>{
        const match=makefile.match(new RegExp('^'+architecture+'_LDFLAGS = (.*)$','m'));
        if(!match)throw Error('The generated PE linker flags are unavailable: '+architecture);
        return [architecture,match[1]+' '+source.peLinkerFlags.join(' ')];
    }));
    const linkerFile=path.join(build,'module-pe-linker-flags.json'),linkerIdentity=JSON.stringify(peLinkerFlags)+'\n';
    if(!fs.existsSync(linkerFile)||fs.readFileSync(linkerFile,'utf8')!==linkerIdentity)
        for(const architecture of Object.keys(peLinkerFlags))
            fs.rmSync(path.join(build,'dlls/winevulkan',architecture+'-windows/winevulkan.dll'),{force:true});
    runMake(['-j'+jobs,...peArchitectures.map(architecture=>architecture+'_CFLAGS='+flags),
        ...Object.entries(peLinkerFlags).map(([architecture,value])=>architecture+'_LDFLAGS='+value),options.hostOnly?'dlls/winevulkan/winevulkan.so':'dlls/winevulkan/all'],{cwd:build,env:environment});
    writeChanged(flagFile,flags+'\n');
    writeChanged(linkerFile,linkerIdentity);
    const modules=modulePaths(host.arch,peArchitectures).filter((_,index)=>!options.hostOnly||index===0);
    const files=modules.map(([,file])=>file);
    for(const file of files)if(!fs.statSync(path.join(build,file),{throwIfNoEntry:false})?.isFile())throw Error('The paired module output is missing: '+file);
    const result={...prepared,build,files,modules,arch:host.arch,readobj:path.join(mingw,'llvm-readobj'),strip:path.join(mingw,'llvm-strip')};
    if(options.output)result.provider=publishModule(result,path.resolve(options.output));
    return result;
}
// The shipped module libraries, each with its place in the Wine build.
export const modulePaths=(arch='x64',peArchitectures=['x86_64','i386'])=>[[wineHost(arch).unix+'/winevulkan.so','dlls/winevulkan/winevulkan.so'],...peArchitectures.map(cpu=>[cpu+'-windows/winevulkan.dll','dlls/winevulkan/'+cpu+'-windows/winevulkan.dll'])];
const MODULES=modulePaths();
/** The shipped module library paths. */
export const MODULE_FILES=MODULES.map(([name])=>name);
/** Check the complete PE export set of the built modules and stage them as shipped:
 * the PE libraries without debug sections, the Unix library ad hoc signed. */
export function finishModule(built,output){
    const MODULES=built.modules||modulePaths(built.arch,built.profile?.architectures.pe);
    if(fs.existsSync(output))throw Error('The immutable module output already exists.');
    const originalSpec=fs.readFileSync(path.join(built.directory,'dlls/winevulkan/winevulkan.spec'),'utf8');
    const expected=[...originalSpec.matchAll(/^@\s+\S+\s+(?:-\S+\s+)*([A-Za-z0-9_]+)(?:\(|\s*$)/gm)].map(row=>row[1]).sort();
    for(const [,file]of MODULES.slice(1)){
        const actual=[...read(built.readobj,['--coff-exports',path.join(built.build,file)]).matchAll(/^\s+Name: ([A-Za-z0-9_]+)$/gm)].map(row=>row[1]).sort();
        if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('The complete PE Vulkan export set differs: '+file);
    }
    fs.mkdirSync(output,{recursive:true});
    for(const [name,file]of MODULES){
        const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(built.build,file),target);fs.chmodSync(target,0o755);
        if(name.endsWith('.dll'))run(built.strip,['--strip-debug',target]);
        else run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);
    }
    return output;
}
/** Describe staged module libraries from the projected Wine source: licenses, provider record, manifest, payload and declaration. */
export function describeModule({directory,output,arch='x64',profile=source,modules=modulePaths(arch,profile.architectures.pe),readobj}){
    const host=wineHost(arch),minimumMacOS=profile.minimumMacOS,MODULES=modules;
    const architectures=file=>{
        if(file.endsWith('.so'))return read('/usr/bin/lipo',['-archs',file]).split(/\s+/);
        const header=read(readobj,['--file-headers',file]);
        const machine=header.match(/Machine: IMAGE_FILE_MACHINE_([A-Z0-9_]+)/)?.[1];
        const cpu={AMD64:'x86_64',I386:'i386',ARM64:'arm64',ARM64EC:'arm64ec',ARM64X:'arm64x'}[machine];
        if(!cpu)throw Error('Unrecognized PE output machine: '+file);
        return [cpu];
    };
    addLicenses(output,'Wine',directory);
    addLicense(output,'Wine authors',path.join(directory,'AUTHORS'));
    addLicenses(output,'Khronos Vulkan',here);
    const files=fs.readdirSync(output,{recursive:true}).filter(name=>name!=='provider.json'&&fs.statSync(path.join(output,name)).isFile()).map(file=>{
        const binary=MODULES.some(([name])=>name===file),native=file.endsWith('.so'),target=path.join(output,file);
        fs.chmodSync(target,binary?0o755:0o644);
        return {path:file,size:fs.statSync(target).size,mode:binary?0o755:0o644,sha256:digest(fs.readFileSync(target)),
            ...(binary?{format:native?'mach-o':'pe',architectures:architectures(target),
                ...(native?{executionArchitecture:host.macho}:{})}:{})};
    });
    const provider={schema:1,provider:source.id,version:profile.version,profile:profile.profile,
        sceneInteropAPI:1,sceneContextAPI:1,wineVulkanDriverVersion:profile.wineVulkanDriverVersion,originalUnixCallCount:profile.unixCallCount,runtimeProfile:profile.runtimeProfile,
        minimumMacOS:minimumMacOS,architectures:{unix:[...new Set(files.filter(file=>file.format==='mach-o').flatMap(file=>file.architectures))],pe:[...new Set(files.filter(file=>file.format==='pe').flatMap(file=>file.architectures))]},originalGpuWorkRetained:true,
        libraries:Object.fromEntries(MODULES.map(([file])=>[file.split('/')[0],file])),files};
    writeChanged(path.join(output,'provider.json'),JSON.stringify(provider,null,2)+'\n');
    const manifest={schemaVersion:1,managerId:source.id,version:profile.version,platform:'darwin',arch:host.arch,minimumMacOS:minimumMacOS,
        executableRelative:provider.libraries[host.unix],provider,files,dependencies:[]};
    const payload=path.join(output,'payload');fs.mkdirSync(payload);
    for(const file of files){const target=path.join(payload,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(output,file.path),target);fs.chmodSync(target,file.mode);}
    const manifestFile=path.join(payload,'manifest.json');writeChanged(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    const declaration={id:source.id,version:profile.version,arch:host.arch,launcherArchitectures:['arm64','x64'],minimumMacOS:minimumMacOS,
        sourceRelative:null,sourceSha256:digest(fs.readFileSync(path.join(here,source.hostProfiles?.[host.arch]||'source.json'))),directoryRelative:[source.id,profile.version,host.arch].join('/'),
        manifestRelative:'manifest.json',manifestSha256:digest(fs.readFileSync(manifestFile)),files:[...files,{path:'manifest.json',
            size:fs.statSync(manifestFile).size,mode:0o644,sha256:digest(fs.readFileSync(manifestFile))}]};
    writeChanged(path.join(output,'runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');return provider;
}
export function publishModule(built,output){return describeModule({directory:built.directory,output:finishModule(built,output),arch:built.arch,profile:built.profile,modules:built.modules,readobj:built.readobj});}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&pathToFileURL(fs.realpathSync(process.argv[1])).href===import.meta.url){
    try{
        const options={};for(let i=2;i<process.argv.length;i++){
            const key=process.argv[i];if(['--check','--prepare-only','--configure-only','--host-only'].includes(key)){options[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=true;continue;}
            if(!['--archive','--work','--mingw','--moltenvk-archive','--vulkan-library','--bison','--bison-archive','--jobs','--output','--arch'].includes(key)||!process.argv[i+1])throw Error('Use --check or --archive SOURCE --work DIRECTORY --mingw BIN [--moltenvk-archive ARCHIVE | --vulkan-library EXACT_LIBRARY] [--bison EXECUTABLE | --bison-archive SOURCE] [--jobs 1|2] [--output NEW_DIRECTORY].');
            options[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=process.argv[++i];
        }
        if(options.check)console.log(JSON.stringify(checkSources(),null,2));
        else if(!options.archive||!options.work||!options.prepareOnly&&(!options.mingw||!options.moltenvkArchive&&!options.vulkanLibrary))throw Error('An exact source archive, owned work directory, compiler directory and declared Vulkan link input are required.');
        else console.log(JSON.stringify(await buildModule({...options,profile:sourceProfile(options.arch)}),null,2));
    }catch(error){console.error(error.stack||error);process.exitCode=1;}
}
