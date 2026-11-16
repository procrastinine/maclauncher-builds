import {wineHost} from '../../../../../../../tools/wine-host.mjs';
// SPDX-License-Identifier: MIT
import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';
import{pathToFileURL}from'node:url';
import{appPath}from'../../../../../../../tools/app-source.mjs';
const here=import.meta.dirname;
// The bridge's file identity, shared by the compile and assemble phases of its users.
export function cameraBridge(arch){const host=wineHost(arch);return {name:'maclauncher-temporal-camera',architecture:host.macho,windows:'x86_64-windows/maclauncher-temporal-camera.dll',unix:host.unix+'/maclauncher-temporal-camera.so'};}
export const CAMERA_BRIDGE=Object.freeze(cameraBridge());
export function buildCameraBridge({compiler,output,arch,hostOnly=false}){
    const host=wineHost(arch);
    const camera='-I'+appPath('src/modules/shared/reshade/temporal');
    const windows=path.join(output,'x86_64-windows'),unix=path.join(output,host.unix);
    fs.mkdirSync(windows,{recursive:true});fs.mkdirSync(unix,{recursive:true});
    const run=(program,args)=>execFileSync(program,args,{stdio:'inherit'}),name='maclauncher-temporal-camera';
    const pe=path.join(windows,name+'.dll'),native=path.join(unix,name+'.so');
    if(!hostOnly){
    run(compiler,['-std=c11','-O2','-shared','-static','-Wl,--no-insert-timestamp',camera,path.join(here,'bridge.c'),'-o',pe]);
    const bytes=fs.readFileSync(pe);if(bytes.readUInt32LE(0x3c)<80)throw Error('No builtin marker space');
    bytes.write('Wine builtin DLL\0',64,'ascii');fs.writeFileSync(pe,bytes);
    }
    run('xcrun',['clang','-std=c11','-arch',host.macho,'-mmacosx-version-min=13.0','-O2','-dynamiclib',camera,path.join(here,'bridge-unix.c'),'-Wl,-install_name,@rpath/'+name+'.so','-o',native]);
    run('codesign',['--force','--sign','-','--timestamp=none',native]);
    return {...CAMERA_BRIDGE,architecture:host.macho,unix:host.unix+'/'+name+'.so'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
    const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>i%2?a:[...a,[x.slice(2),v[i+1]]],[]));
    args.hostOnly=args['host-only']==='1';
    if(!args.output||!args.hostOnly&&!args.compiler)throw Error('Use --compiler x86_64-w64-mingw32-clang --output directory');
    console.log(JSON.stringify(buildCameraBridge(args)));
}
