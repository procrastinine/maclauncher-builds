import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const linuxTools=Object.freeze({
 cmake:{packages:['cmake'],commands:['cmake','ctest','cpack']},
 ninja:{packages:['ninja-build'],commands:['ninja']},
 meson:{packages:['meson'],commands:['meson']},
 pkgconf:{packages:['pkgconf'],commands:['pkgconf','pkg-config']},
 uv:{packages:['python3-venv'],commands:['uv']},
 go:{packages:['golang-go'],commands:['go','gofmt']},
 'git-lfs':{packages:['git-lfs'],commands:['git-lfs']},
 autoconf:{packages:['autoconf'],commands:['autoconf','autoheader','autoreconf','autom4te','autoscan','autoupdate','ifnames']},
 automake:{packages:['automake'],commands:['automake','aclocal']},
 libtool:{packages:['libtool','libtool-bin','libltdl-dev'],commands:['libtool','libtoolize']},
 bison:{packages:['bison'],commands:['bison']},
 flex:{packages:['flex'],commands:['flex']},
 make:{packages:['make'],commands:['make']},
 gcc:{packages:['gcc','g++'],commands:['gcc','g++']},
 clang:{packages:['clang'],commands:['clang','clang++']},
 llvm:{packages:['llvm','llvm-dev','clang','lld'],commands:['llvm-config','llvm-ar','llvm-readelf','llvm-objcopy','clang','clang++','ld.lld']},
 nasm:{packages:['nasm'],commands:['nasm']},
 patchelf:{packages:['patchelf'],commands:['patchelf']},
 unzip:{packages:['unzip'],commands:['unzip']},
 zip:{packages:['zip'],commands:['zip']},
 xz:{packages:['xz-utils'],commands:['xz']},
 zstd:{packages:['zstd'],commands:['zstd']}
});
export function linuxToolSelection(tools){
 if(!Array.isArray(tools)||tools.some(name=>typeof name!=='string'||!Object.hasOwn(linuxTools,name)))throw Error('A Linux recipe names an unsupported build tool.');
 return {packages:[...new Set(tools.flatMap(name=>linuxTools[name].packages))],commands:[...new Set(tools.flatMap(name=>linuxTools[name].commands))]};
}
export function installedToolsDirectory(environment=process.env){
 const root=environment.RUNNER_TEMP||os.tmpdir();
 if(!path.isAbsolute(root))throw Error('Build-tool installation requires an absolute temporary directory.');
 return path.join(root,'runtime-installed-tools');
}
/** Install the declared host tools; source and package architectures are independent. */
export function installBuildTools(tools,{platform=process.platform,environment=process.env,execute=(command,args,options)=>execFileSync(command,args,options),rootUser=process.getuid?.()===0}={}){
 if(!Array.isArray(tools)||tools.some(name=>!(/^[a-z0-9][a-z0-9@+._-]{0,63}$/).test(name)))throw Error('Choose declared build-tool names.');
 if(!tools.length)return {tools:[],platform};
 const run=(command,args)=>execute(command,args,{env:{...environment,DEBIAN_FRONTEND:'noninteractive'},stdio:'inherit'});
 if(platform==='darwin'){run('brew',['install',...tools]);return {tools,platform};}
 if(platform!=='linux')throw Error('Runtime build tools support macOS and Linux.');
 const selected=linuxToolSelection(tools),apt=args=>rootUser?run('apt-get',args):run('sudo',['apt-get',...args]);
 apt(['update']);apt(['install','--yes','--no-install-recommends',...selected.packages]);
 if(tools.includes('uv')){
  const root=installedToolsDirectory(environment),venv=path.join(root,'uv'),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  run('python3',['-m','venv',venv]);
  run(path.join(venv,'bin/python'),['-m','pip','install','--disable-pip-version-check','--only-binary=:all:','--no-deps','--require-hashes','--requirement',new URL('./linux-build-requirements.txt',import.meta.url).pathname]);
  const target=path.join(bin,'uv'),source=path.join(venv,'bin/uv');
  if(fs.existsSync(target)){if(!fs.lstatSync(target).isSymbolicLink()||fs.readlinkSync(target)!==source)throw Error('Refuse to replace an unmanaged build tool.');}
  else fs.symlinkSync(source,target);
  if(environment.GITHUB_PATH)fs.appendFileSync(environment.GITHUB_PATH,bin+'\n');
 }
 return {tools,platform,packages:selected.packages};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--tools')throw Error('Use --tools "declared tool names".');console.log(JSON.stringify(installBuildTools(args[1].split(/\s+/).filter(Boolean))));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
