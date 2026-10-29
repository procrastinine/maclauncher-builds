import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {applyOverlays} from './overlays/apply.mjs';
import {prepareDependencies} from './dependencies.mjs';

const require = createRequire(import.meta.url);
const B = require('../../lib/bundled-native.cjs');
const Native = require('../../lib/local-native.cjs');
const MachO = require('../maclauncher/src/modules/shared/runtime/macho-load-commands.js');
const producer = import.meta.dirname, repository = path.resolve(producer, '../..');
const pin = JSON.parse(fs.readFileSync(path.join(producer, 'source.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = (tool, args, options = {}) => execFileSync(tool, args, {encoding:'utf8', ...options}).trim();
const run = (tool, args, options = {}) => execFileSync(tool, args, {stdio:'inherit', ...options});

function files(root) {
    return fs.readdirSync(root, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(path.join(root,entry.name)) : [path.join(root,entry.name)]);
}
function copyFile(source, destination) {
    fs.mkdirSync(path.dirname(destination), {recursive:true}); fs.copyFileSync(source,destination); fs.chmodSync(destination,fs.statSync(source).mode&0o777);
}
function mapFiles(root, destination, select = () => true) {
    for (const file of files(root)) {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('Runtime inputs must be regular files.');
        const relative = path.relative(root,file); if (select(relative)) copyFile(file,path.join(destination,relative));
    }
}
function inputFiles() {
    return files(producer).filter(file => !path.relative(producer,file).split(path.sep).some(part => part.startsWith('.')))
        .map(file => ({path:path.relative(producer,file).split(path.sep).join('/'),sha256:sha(fs.readFileSync(file))}));
}
function cached(command, args, inputs, output, options = {}) {
    const identity = sha(JSON.stringify({command,args,inputs:inputs.map(file=>[file,sha(fs.readFileSync(file))])}));
    const record = output + '.inputs';
    if (fs.existsSync(output) && fs.existsSync(record) && fs.readFileSync(record,'utf8') === identity) return;
    fs.mkdirSync(path.dirname(output), {recursive:true}); run(command,args,options); fs.writeFileSync(record,identity);
}
async function pool(items, count, callback) {
    let index = 0;
    await Promise.all(Array.from({length:count},async()=>{while(index<items.length)await callback(items[index++]);}));
}
async function compile(tool,args,options) {
    await new Promise((resolve,reject)=>{
        const child=spawn(tool,args,{stdio:'inherit',...options}); child.once('error',reject);
        child.once('close',code=>code===0?resolve():reject(Error(tool+' exited '+code)));
    });
}
function nativeFile(file) {
    const fd=fs.openSync(file,'r'),magic=Buffer.alloc(4);fs.readSync(fd,magic,0,4,0);fs.closeSync(fd);
    return ['cffaedfe','feedfacf','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex'));
}
function nativeClosure(output) {
    const all=files(output),result=[];
    for(const file of all.filter(nativeFile)){
        const info=MachO.readMachOLoadCommands(file),links=new Set();let changed=false;
        const relative=path.relative(output,file).split(path.sep).join('/');
        const executable=relative.startsWith('python/')?path.join(output,'python/bin'):relative.startsWith('dotnet/')?path.join(output,'dotnet'):path.dirname(file);
        const expand=value=>value.startsWith('@loader_path/')?path.resolve(path.dirname(file),value.slice(13)):value.startsWith('@executable_path/')?path.resolve(executable,value.slice(17)):value;
        for(const image of info.slices){
            if(image.minimumMacOS&&!B.versionAtLeast(pin.minimumMacOS,image.minimumMacOS))throw Error('Native input requires a newer macOS: '+relative);
            for(const dependency of image.dependencies){
                const link=dependency.path;if(link.startsWith('/usr/lib/')||link.startsWith('/System/Library/')){links.add(link);continue;}
                const direct=expand(link),candidates=link.startsWith('@rpath/')?[...image.runPaths.map(rpath=>path.join(expand(rpath),link.slice(7))),...all.filter(candidate=>path.basename(candidate)===path.basename(link))]:[direct];
                const selected=candidates.find(candidate=>path.isAbsolute(candidate)&&candidate.startsWith(output+path.sep)&&fs.existsSync(candidate));
                if(!selected)throw Error('Native dependency is absent from the runtime: '+relative+' -> '+link);
                const normalized='@loader_path/'+path.relative(path.dirname(file),selected).split(path.sep).join('/');
                if(normalized!==link){run('/usr/bin/install_name_tool',['-change',link,normalized,file]);changed=true;}
                links.add(normalized);
            }
        }
        if(changed)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);
        try{execFileSync('/usr/bin/codesign',['--verify','--strict',file],{stdio:'ignore'});}catch{run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);run('/usr/bin/codesign',['--verify','--strict',file]);}
        result.push({file:relative,links:[...links]});
    }
    return result;
}

function exportSource(source, work, identity) {
    const projected=path.join(work,'source'),record=path.join(work,'projection.json');
    if(fs.existsSync(record)&&JSON.parse(fs.readFileSync(record)).identity===identity&&fs.existsSync(projected))return projected;
    fs.rmSync(projected,{recursive:true,force:true});fs.mkdirSync(projected,{recursive:true});
    const archive=path.join(work,'source.tar');run('git',['-C',source,'archive','--format=tar','--output',archive,pin.source.revision]);
    run('/usr/bin/tar',['-xf',archive,'-C',projected]);fs.unlinkSync(archive);applyOverlays(projected);json(record,{identity});return projected;
}

function metalTool(output) {
    const executable=path.join(output,'bin/xcrun'),source=path.join(producer,'runtime/metal-toolchain.m');
    cached('/usr/bin/clang',['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-fobjc-arc','-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',source,'-framework','Foundation','-o',executable],[source],executable);
    run(executable,['--check-native-metal']);
    return executable;
}

async function nativeHost(source,work,output,jobs) {
    const owned=path.join(source,'nxnative'),host=path.join(source,'dm/host'),gfx=path.join(source,'dm/gfx'),third=path.join(source,'dm/third_party');
    const flags=['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-O1','-Wno-unused-function','-fobjc-arc','-ffile-prefix-map='+source+'=/nxnative','-fdebug-prefix-map='+work+'=/build'];
    const include=[owned,path.join(gfx,'nvn/include'),path.join(third,'vulkan-headers/include'),path.join(third,'libvpx'),path.join(third,'stb_vorbis')].map(file=>'-I'+file);
    const vpx=path.join(third,'libvpx'),vpxSources=files(vpx).filter(file=>file.endsWith('.c')),vpxHeaders=files(vpx).filter(file=>file.endsWith('.h'));
    const vpxObjects=vpxSources.map(file=>path.join(work,'native/vpx',path.relative(vpx,file)+'.o'));
    await pool(vpxSources,jobs,async(file)=>{
        const object=vpxObjects[vpxSources.indexOf(file)],args=['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-O2','-ffile-prefix-map='+source+'=/nxnative','-I'+vpx,'-I'+path.join(vpx,'config'),'-c',file,'-o',object];
        const identity=sha(JSON.stringify([args,sha(fs.readFileSync(file)),...vpxHeaders.map(header=>sha(fs.readFileSync(header)))]));
        if(fs.existsSync(object)&&fs.existsSync(object+'.inputs')&&fs.readFileSync(object+'.inputs','utf8')===identity)return;
        fs.mkdirSync(path.dirname(object),{recursive:true});await compile('/usr/bin/clang',args);fs.writeFileSync(object+'.inputs',identity);
    });
    const library=path.join(work,'native/libvpx.a');run('/usr/bin/ar',['rcs',library,...vpxObjects]);
    const names=['main.c','loader.c','hle.c','crash.c','probe.c','thread.c','memstat.m','haptics_apple.m','front_mac.m','entry.S',...fs.readdirSync(host).filter(name=>/^hle_.*\.c$/.test(name))];
    const sources=[...new Set(names)].map(name=>path.join(host,name));
    for(const directory of [gfx,path.join(gfx,'nvn'),path.join(gfx,'tex'),path.join(gfx,'vk'),path.join(gfx,'gl')])for(const name of fs.readdirSync(directory))if(/\.(c|m|S)$/.test(name))sources.push(path.join(directory,name));
    sources.push(path.join(owned,'profile.c'),path.join(owned,'metal_library.m'));
    const headers=files(source).filter(file=>/\.(h|inc)$/.test(file));
    const executable=path.join(output,'bin/nxnative-host');
    const args=[...flags,...include,'-o',executable,...sources,library];
    for(const framework of ['Cocoa','QuartzCore','Metal','MetalFX','IOKit','GameController','CoreHaptics','AudioToolbox','VideoToolbox','CoreMedia','CoreVideo','ImageIO','UniformTypeIdentifiers'])args.push('-framework',framework);
    cached('/usr/bin/clang',args,[...sources,...headers,library],executable);
    const bootstrap=path.join(output,'bin/nxnative');
    cached('/usr/bin/clang',['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',path.join(producer,'runtime/bootstrap.c'),'-o',bootstrap],[path.join(producer,'runtime/bootstrap.c')],bootstrap);
    const metal=metalTool(output);
    for(const file of [executable,metal,bootstrap]){run('/usr/bin/strip',['-S',file]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);run('/usr/bin/codesign',['--verify','--strict',file]);}
}

export async function buildNxNative({work,output,dependencyWork,jobs=4,version=pin.version,check=false}={}) {
    const source=fs.realpathSync(path.join(repository,pin.source.path));
    if(read('git',['-C',source,'rev-parse','HEAD'])!==pin.source.revision||read('git',['-C',source,'status','--porcelain','--untracked-files=no']))throw Error('nxnative source differs from its pin.');
    if(check)return {id:pin.id,revision:pin.source.revision,architecture:pin.architecture};
    if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('nxnative builds require Apple Silicon macOS.');
    if(!path.isAbsolute(work||'')||!path.isAbsolute(output||'')||!Number.isInteger(jobs)||jobs<1||jobs>8)throw Error('Use absolute work/output paths and one to eight jobs.');
    if(work===source||output===source||work.startsWith(source+path.sep)||output.startsWith(source+path.sep))throw Error('Build paths must be outside the upstream checkout.');
    if(fs.existsSync(path.join(output,'manifest.json')))throw Error('The output already contains a sealed runtime. Select a new output directory.');
    fs.mkdirSync(work,{recursive:true});fs.mkdirSync(output,{recursive:true});
    const owned=inputFiles(),identity=sha(JSON.stringify({source:pin.source,owned})),projected=exportSource(source,work,identity);
    const dependencies=await prepareDependencies({work:dependencyWork||path.join(work,'dependencies'),output,jobs});
    const env={...process.env,PATH:[path.join(output,'bin'),path.join(output,'python/bin'),path.join(output,'dotnet'),process.env.PATH].join(path.delimiter),SPIRV_CROSS:path.join(output,'bin/spirv-cross'),DOTNET_ROOT:path.join(output,'dotnet'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_CLI_HOME:path.join(work,'dotnet-home'),NUGET_PACKAGES:path.join(work,'nuget'),PYTHONDONTWRITEBYTECODE:'1'};
    const sdk=read('/usr/bin/which',['dotnet']),sdkEnvironment={...env};delete sdkEnvironment.DOTNET_ROOT;
    const nxProject=path.join(projected,'dm/tools/nx_extract/nx_extract.csproj'),lock=path.join(producer,'nx-extract.lock.json');
    run(sdk,['restore',nxProject,'--runtime','osx-arm64','--locked-mode','--lock-file-path',lock],{env:sdkEnvironment});
    run(sdk,['publish',nxProject,'--no-restore','--runtime','osx-arm64','--self-contained','false','-c','Release','-o',path.join(output,'tools/nx_extract'),'-p:DebugType=None','-p:DebugSymbols=false','-p:PathMap='+projected+'=/nxnative'],{env:sdkEnvironment});
    metalTool(output);
    const python=path.join(output,'python/bin/python3');
    run(python,[path.join(projected,'dm/gfx/tools/dmsh_chain.py'),'--update-lock'],{env});
    run(python,[path.join(projected,'dm/gfx/tools/dmsh_chain.py'),'--header'],{env});
    await nativeHost(projected,work,output,jobs);
    const share=path.join(output,'share/nxnative');
    for(const directory of ['scripts','dm/games','dm/tools','dm/gfx/tools','dm/gfx/nvn','dm/ios/tools']){
        const input=path.join(projected,directory);
        mapFiles(input,path.join(share,directory),relative=>{
            const parts=relative.split(path.sep);if(parts.some(part=>['tests','fixtures','__pycache__'].includes(part)))return false;
            if(directory==='dm/gfx/nvn')return relative==='dmsh_chain.h';
            if(directory==='dm/tools')return relative.endsWith('.py')&&!['docs_symptoms.py'].includes(relative)||['nx_extract/Program.cs','nx_extract/nx_extract.csproj'].includes(relative.split(path.sep).join('/'));
            if(directory==='dm/gfx/tools')return relative.endsWith('.py')||relative==='dmsh_chain.lock'||relative.startsWith('dmsh_xlate_bin'+path.sep)&&!relative.endsWith('.pdb')||['dmsh_xlate/Program.cs','dmsh_xlate/dmsh_xlate.csproj'].includes(relative.split(path.sep).join('/'));
            return !relative.endsWith('README.md')&&!relative.endsWith('.md')&&!relative.endsWith('.sh')&&!relative.endsWith('.csproj');
        });
    }
    copyFile(path.join(producer,'runtime/nxnative.py'),path.join(output,'runtime/nxnative.py'));
    const runtime={schemaVersion:1,id:pin.id,version,sourceRevision:pin.source.revision,nativeSourceRevision:pin.source.revision,architecture:pin.architecture,minimumMacOS:pin.minimumMacOS,executableRelative:pin.output.executableRelative,runtimeFiles:{cli:'runtime/nxnative.py',host:'bin/nxnative-host',profileRoot:'share/nxnative/dm/games',extractor:'tools/nx_extract/nx_extract',python:'python/bin/python3',dotnet:'dotnet/dotnet'}};
    runtime.capabilities={metalSourceObjects:true,nativeMetalObjects:true};
    runtime.requirements={metalCompiler:{delivery:'system',required:true,command:'/usr/bin/xcrun',sdk:'macosx',tools:['metal','metallib'],options:['-O1','-fpreserve-invariance'],version:read('/usr/bin/xcrun',['-sdk','macosx','metal','--version']).split('\n')[0],managedAcquisition:false}};
    json(path.join(output,'runtime.json'),runtime);
    const origins={schemaVersion:1,id:pin.id,version,source:pin.source,producerInputs:owned,dependencies,nuget:JSON.parse(fs.readFileSync(lock))};json(path.join(output,'source.json'),origins);
    const notices=(dependencies.licenses||[]).map(file=>{
        const parts=file.split('/'),group=parts[2];
        const wheel=group==='python-wheels'?dependencies.inputs.find(input=>input.id==='python:'+parts[3]):null;
        const input=wheel||dependencies.inputs.find(input=>input.id===group);
        return {name:wheel?parts[3]:group,license:input?.license||'Upstream license notices',path:file,sourceUrl:(input?.repository||'https://github.com/seedds/nxnative').replace(/^http:\/\/github\.com\//,'https://github.com/')};
    });
    for(const [name,relative,license]of[['nxnative','LICENSE','MIT'],['libvpx','dm/third_party/libvpx/LICENSE','BSD-3-Clause'],['libvpx patent grant','dm/third_party/libvpx/PATENTS','Patent grant'],['stb_vorbis','dm/third_party/stb_vorbis/LICENSE','MIT'],['Ryujinx','dm/third_party/ryujinx/LICENSE.txt','MIT'],['Spv.Generator','dm/third_party/ryujinx/src/Spv.Generator/LICENSE','MIT'],['Vulkan-Headers','dm/third_party/vulkan-headers/LICENSE.md','Apache-2.0 or MIT'],['MacNativeGames','dm/third_party/macnativegames/LICENSE','MIT']]){
        let file=path.join(source,relative);if(!fs.existsSync(file)&&name==='MacNativeGames')file=path.join(source,'dm/gfx/nvn/macnativegames/LICENSE');
        if(!fs.existsSync(file))throw Error('Missing runtime notice: '+relative);
        const destination='licenses/nxnative/'+name.replace(/[^A-Za-z0-9.-]/g,'-')+'.txt';copyFile(file,path.join(output,destination));notices.push({name,license,sourceUrl:pin.source.repository,path:destination});
    }
    const nvn=fs.readFileSync(path.join(source,'dm/gfx/nvn/include/nvn.h'),'utf8');
    fs.writeFileSync(path.join(output,'licenses/nxnative/NVN.txt'),nvn.slice(0,nvn.indexOf('*/')+2)+'\n');
    notices.push({name:'NVN interface',license:'MIT',sourceUrl:pin.source.repository,path:'licenses/nxnative/NVN.txt'});
    for(const [name,file,license,url]of[['deko3d','deko3d.txt','Zlib','https://github.com/devkitPro/deko3d'],['LibHac','LibHac.txt','MIT','https://www.nuget.org/packages/LibHac/0.19.0']]){
        const destination='licenses/nxnative/'+file;copyFile(path.join(producer,'licenses',file),path.join(output,destination));notices.push({name,license,sourceUrl:url,path:destination});
    }
    const closure=nativeClosure(output);
    for(const file of files(output)){const mode=fs.statSync(file).mode&0o777;fs.chmodSync(file,mode&0o111?0o755:0o644);}
    const inventory=B.fileInventory(output).filter(file=>!file.endsWith('.inputs')).map(relative=>{
        const file=path.join(output,relative),stat=fs.statSync(file);let architectures;
        if(nativeFile(file))architectures=Native.readMachOArchitectures(file,{allowLibrary:true});
        return {path:relative,size:stat.size,mode:stat.mode&0o777,sha256:sha(fs.readFileSync(file)),...(architectures?{architectures}:{})};
    });
    for(const file of files(output).filter(file=>file.endsWith('.inputs')))fs.unlinkSync(file);
    const manifest={schemaVersion:1,managerId:pin.id,version,upstreamRevision:pin.source.revision,platform:pin.platform,arch:pin.architecture,minimumMacOS:pin.minimumMacOS,executableRelative:pin.output.executableRelative,files:inventory,dependencies:closure,notices,provenance:{sourceUrl:pin.source.repository,sourceRevision:pin.source.revision,verifiedBuild:true,producerInputs:owned}};
    B.validateManifest(manifest);B.verifyPayload(output,manifest);json(path.join(output,'manifest.json'),manifest);
    return {id:pin.id,version,output,executable:path.join(output,pin.output.executableRelative)};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
    const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index]?.slice(2),value=process.argv[index+1];if(!['work','output','dependency-work','jobs','version'].includes(key)||!value)throw Error('Use --work, --output, --dependency-work, --jobs or --version.');options[key==='dependency-work'?'dependencyWork':key]=key==='jobs'?Number(value):value;}
    buildNxNative(options).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
