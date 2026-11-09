import {appRequire} from '../../tools/app-source.mjs';
import {gitlink,sourceCheckout,sourceProvenance,sourceRevision} from '../../lib/pins.mjs';
import {addLicense,addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {applyOverlays} from './overlays/apply.mjs';
import {prepareDependencies} from './dependencies.mjs';

const require = createRequire(import.meta.url);
const B = appRequire('src/modules/shared/runtime/bundled-native.js');
const Native = appRequire('src/modules/shared/runtime/local-native.js');
const MachO = appRequire('src/modules/shared/runtime/macho-load-commands.js');
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
            for(const dependency of image.dependencies){
                const link=dependency.path;if(link.startsWith('/usr/lib/')||link.startsWith('/System/Library/')){links.add(link);continue;}
                const direct=expand(link),candidates=link.startsWith('@rpath/')?[...image.runPaths.map(rpath=>path.join(expand(rpath),link.slice(7))),...all.filter(candidate=>path.basename(candidate)===path.basename(link))]:[direct];
                const selected=candidates.find(candidate=>path.isAbsolute(candidate)&&candidate.startsWith(path.resolve(output)+path.sep)&&fs.existsSync(candidate));
                if(!selected){links.add(link);continue;}
                const normalized='@loader_path/'+path.relative(path.dirname(file),selected).split(path.sep).join('/');
                if(normalized!==link){run('/usr/bin/install_name_tool',['-change',link,normalized,file]);changed=true;}
                links.add(normalized);
            }
        }
        if(changed)run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);
        try{execFileSync('/usr/bin/codesign',['--verify','--strict',file],{stdio:'ignore'});}catch{run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);}
        result.push({file:relative,links:[...links]});
    }
    return result;
}

function exportSource(source, work, identity) {
    const projected=path.join(work,'source'),record=path.join(work,'projection.json');
    if(fs.existsSync(record)&&JSON.parse(fs.readFileSync(record)).identity===identity&&fs.existsSync(projected))return projected;
    fs.rmSync(projected,{recursive:true,force:true});fs.mkdirSync(projected,{recursive:true});
    const archive=path.join(work,'source.tar');run('git',['-C',source,'archive','--format=tar','--output',archive,sourceRevision(pin.source)]);
    run('/usr/bin/tar',['-xf',archive,'-C',projected]);fs.unlinkSync(archive);applyOverlays(projected);json(record,{identity});return projected;
}

function metalTool(output) {
    const executable=path.join(output,'bin/xcrun'),source=path.join(producer,'runtime/metal-toolchain.m');
    cached('/usr/bin/clang',['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-fobjc-arc','-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',source,'-framework','Foundation','-o',executable],[source],executable);
    run(executable,['--check-native-metal']);
    return executable;
}

async function nativeHost(source,work,output,jobs) {
    const owned=path.join(source,'nxnative'),host=path.join(source,'dm/host');
    const flags=['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-O1','-Wno-unused-function','-fobjc-arc','-ffile-prefix-map='+source+'=/nxnative','-fdebug-prefix-map='+work+'=/build','-I'+owned];
    run('make',['-C',host,'-j'+jobs,'dmhost','CFLAGS='+flags.join(' '),'MACOS_MIN='+pin.minimumMacOS],{env:{...process.env,PATH:path.join(output,'python/bin')+path.delimiter+process.env.PATH}});
    const executable=path.join(output,'bin/nxnative-host');copyFile(path.join(host,'dmhost'),executable);
    const bootstrap=path.join(output,'bin/nxnative');
    cached('/usr/bin/clang',['-arch','arm64','-mmacosx-version-min='+pin.minimumMacOS,'-O2','-ffile-prefix-map='+producer+'=/nxnative-producer',path.join(producer,'runtime/bootstrap.c'),'-o',bootstrap],[path.join(producer,'runtime/bootstrap.c')],bootstrap);
    const metal=metalTool(output);
    for(const file of [executable,metal,bootstrap]){run('/usr/bin/strip',['-S',file]);run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);}
}

export async function buildNxNative({work,output,dependencyWork,jobs=4,version=pin.version,check=false}={}) {
    const source=fs.realpathSync(path.join(repository,sourceCheckout(pin.source)));
    if(read('git',['-C',source,'rev-parse','HEAD'])!==sourceRevision(pin.source)||read('git',['-C',source,'status','--porcelain','--untracked-files=no']))throw Error('nxnative source differs from its pin.');
    if(check)return {id:pin.id,revision:sourceRevision(pin.source),architecture:pin.architecture};
    if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('nxnative builds require Apple Silicon macOS.');
    if(!path.isAbsolute(work||'')||!path.isAbsolute(output||'')||!Number.isInteger(jobs)||jobs<1||jobs>8)throw Error('Use absolute work/output paths and one to eight jobs.');
    if(work===source||output===source||work.startsWith(source+path.sep)||output.startsWith(source+path.sep))throw Error('Build paths must be outside the upstream checkout.');
    if(fs.existsSync(path.join(output,'manifest.json')))throw Error('The output already contains a sealed runtime. Select a new output directory.');
    fs.mkdirSync(work,{recursive:true});fs.mkdirSync(output,{recursive:true});
    const owned=inputFiles(),identity=sha(JSON.stringify({source:sourceProvenance(pin.source),owned})),projected=exportSource(source,work,identity);
    const dependencies=await prepareDependencies({work:dependencyWork||path.join(work,'dependencies'),output,jobs});
    const env={...process.env,PATH:[path.join(output,'bin'),path.join(output,'python/bin'),path.join(output,'dotnet'),process.env.PATH].join(path.delimiter),SPIRV_CROSS:path.join(output,'bin/spirv-cross'),DOTNET_ROOT:path.join(output,'dotnet'),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_CLI_HOME:path.join(work,'dotnet-home'),NUGET_PACKAGES:path.join(work,'nuget'),PYTHONDONTWRITEBYTECODE:'1'};
    const sdk=read('/usr/bin/which',['dotnet']),sdkEnvironment={...env};delete sdkEnvironment.DOTNET_ROOT;
    const nxProject=path.join(projected,'dm/tools/nx_extract/nx_extract.csproj'),lock=path.join(producer,'nx-extract.lock.json');
    run(sdk,['restore',nxProject,'--runtime','osx-arm64','--locked-mode','--lock-file-path',lock],{env:sdkEnvironment});
    run(sdk,['publish',nxProject,'--no-restore','--runtime','osx-arm64','--self-contained','false','-c','Release','-o',path.join(output,'tools/nx_extract'),'-p:DebugType=None','-p:DebugSymbols=false','-p:PathMap='+projected+'=/nxnative'],{env:sdkEnvironment});
    metalTool(output);
    const python=path.join(output,'python/bin/python3');
    run(python,[path.join(projected,'dm/gfx/tools/tool_lock.py'),'--update-lock'],{env});
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
    for (const name of ['keyless_input.py']) copyFile(path.join(producer,'runtime',name),path.join(output,'runtime',name));
    const runtime={schemaVersion:1,id:pin.id,version,sourceRevision:sourceRevision(pin.source),nativeSourceRevision:sourceRevision(pin.source),architecture:pin.architecture,minimumMacOS:pin.minimumMacOS,executableRelative:pin.output.executableRelative,runtimeFiles:{cli:'runtime/nxnative.py',host:'bin/nxnative-host',profileRoot:'share/nxnative/dm/games',extractor:'tools/nx_extract/nx_extract',python:'python/bin/python3',dotnet:'dotnet/dotnet'}};
    runtime.capabilities={metalSourceObjects:true,nativeMetalObjects:true,keylessInputs:["nup","dump"],packageSelection:true};
    runtime.requirements={metalCompiler:{delivery:'system',required:true,command:'/usr/bin/xcrun',sdk:'macosx',tools:['metal','metallib'],options:['-O1','-fpreserve-invariance'],version:read('/usr/bin/xcrun',['-sdk','macosx','metal','--version']).split('\n')[0],managedAcquisition:false}};
    json(path.join(output,'runtime.json'),runtime);
    const origins={schemaVersion:1,id:pin.id,version,source:sourceProvenance(pin.source),producerInputs:owned,dependencies,nuget:JSON.parse(fs.readFileSync(lock))};json(path.join(output,'source.json'),origins);
    addLicenses(output,pin.id,source);
    addLicenses(output,'libvpx',path.join(source,'dm/third_party/libvpx'));
    addLicense(output,'libvpx patent grant',path.join(source,'dm/third_party/libvpx/PATENTS'));
    addLicenses(output,'dav1d',path.join(source,'dm/third_party/dav1d'));
    addLicenses(output,'stb_vorbis',path.join(source,'dm/third_party/stb_vorbis'));
    addLicenses(output,'Ryujinx',path.join(source,'dm/third_party/ryujinx'));
    addLicenses(output,'Spv.Generator',path.join(source,'dm/third_party/ryujinx/src/Spv.Generator'));
    addLicenses(output,'Vulkan-Headers',path.join(source,'dm/third_party/vulkan-headers'));
    addLicenses(output,'MacNativeGames',path.join(source,'dm/third_party/macnativegames'));
    addLicense(output,'NVN',path.join(producer,'licenses/NVN.txt'));
    addLicense(output,'deko3d',path.join(producer,'licenses/deko3d.txt'));
    addLicense(output,'LibHac',path.join(producer,'licenses/LibHac.txt'));
    const closure=nativeClosure(output);
    for(const file of files(output)){const mode=fs.statSync(file).mode&0o777;fs.chmodSync(file,mode&0o111?0o755:0o644);}
    const inventory=B.fileInventory(output).filter(file=>!file.endsWith('.inputs')).map(relative=>{
        const file=path.join(output,relative),stat=fs.statSync(file);let architectures;
        if(nativeFile(file))architectures=Native.readMachOArchitectures(file,{allowLibrary:true});
        return {path:relative,size:stat.size,mode:stat.mode&0o777,sha256:sha(fs.readFileSync(file)),...(architectures?{architectures}:{})};
    });
    for(const file of files(output).filter(file=>file.endsWith('.inputs')))fs.unlinkSync(file);
    const manifest={schemaVersion:1,managerId:pin.id,version,upstreamRevision:sourceRevision(pin.source),platform:pin.platform,arch:pin.architecture,minimumMacOS:pin.minimumMacOS,executableRelative:pin.output.executableRelative,files:inventory,dependencies:closure,provenance:{sourceUrl:pin.source.repository,sourceRevision:sourceRevision(pin.source),verifiedBuild:true,producerInputs:owned}};
    B.validateManifest(manifest);json(path.join(output,'manifest.json'),manifest);
    return {id:pin.id,version,output,executable:path.join(output,pin.output.executableRelative)};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
    const options={};for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index]?.slice(2),value=process.argv[index+1];if(!['work','output','dependency-work','jobs','version'].includes(key)||!value)throw Error('Use --work, --output, --dependency-work, --jobs or --version.');options[key==='dependency-work'?'dependencyWork':key]=key==='jobs'?Number(value):value;}
    buildNxNative(options).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
