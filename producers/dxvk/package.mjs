import {appRequire} from '../../tools/app-source.mjs';
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {sourceRevision} from './build.mjs';
import {publicDeclaration} from '../../tools/runtime-package.mjs';
const require=createRequire(import.meta.url),B=appRequire('src/modules/shared/runtime/bundled-native.js'),{readPeExports}=appRequire('src/modules/shared/runtime/pe-exports.js');
// Launcher floor: app package.json build.mac.minimumSystemVersion.
// The Builds producer snapshot does not include that packaging property.
const launcherMinimumMacOS='13.0';
const root=path.resolve(import.meta.dirname,'../..'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
/** Package a completed renderer through the ordinary shared runtime contract. */
export function packageProvider({input,output,project='dxvk',version,arch='universal',minimumMacOS=launcherMinimumMacOS}={}){
  input=fs.realpathSync(input);output=path.resolve(output);
  if(output===input||output.startsWith(input+path.sep)||input.startsWith(output+path.sep))throw Error('Renderer package work must not overlap its input.');
  if(fs.existsSync(output))throw Error('The immutable renderer package output already exists.');
  const payload=path.join(output,'payload');fs.mkdirSync(output,{recursive:true});
  fs.cpSync(input,payload,{recursive:true});
  const source={repository:'https://github.com/procrastinine/maclauncher-builds',revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    upstream:{repository:'https://github.com/doitsujin/dxvk',revision:sourceRevision()}};
  const metadata={schemaVersion:1,managerId:project,version,arch,platform:'windows',guestArchitectures:['x86','x86_64'],
    ...(minimumMacOS?{minimumMacOS}:{}),capabilities:{opaqueComposition:true},upstreamRevision:source.upstream.revision};
  fs.writeFileSync(path.join(payload,'source.json'),JSON.stringify(source,null,2)+'\n');
  fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(metadata,null,2)+'\n');
  const files=B.fileInventory(payload).map(relative=>{
    const file=path.join(payload,relative),bytes=fs.readFileSync(file),pe=relative.endsWith('.dll')?readPeExports(file):null,mode=relative.endsWith('.dll')?0o755:0o644;
    fs.chmodSync(file,mode);
    return {path:relative,size:bytes.length,sha256:sha(bytes),mode,...(pe?{format:'pe',architectures:[pe.architecture]}:{})};
  });
  const declaration={id:project,version,arch,launcherArchitectures:['arm64','x64'],...(minimumMacOS?{minimumMacOS}:{}),
    directoryRelative:project+'/'+version+'/'+arch,sourceRelative:'source.json',sourceSha256:files.find(f=>f.path==='source.json').sha256,
    manifestRelative:'manifest.json',manifestSha256:files.find(f=>f.path==='manifest.json').sha256,files,redistribution:'bundle'};
  publicDeclaration(declaration);
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n');
  return {project,version,arch,output};
}
