import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {publicDeclaration} from './runtime-package.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs'),B=require('../lib/bundled-native.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function regular(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Manager inputs must be regular files.');return stat;}
/** Adapt an existing sealed manager output without changing its files or manifest. */
export async function managerDeclaration({project,input,source}){
 const file=path.join(input,'manifest.json'),bytes=fs.readFileSync(file),m=B.validateManifest(JSON.parse(bytes),{managerId:project});B.verifyPayload(path.join(input,'files'),m);
 // Mac CPUs follow from the binary alone: Intel code also runs on Apple Silicon through Rosetta.
 const manifestSha256=digest(bytes),launcherArchitectures=m.arch==='arm64'?['arm64']:['arm64','x64'];
 const files=m.files.map(f=>({...f,path:'files/'+f.path,...(m.arch==='x64'&&f.architectures?{executionArchitecture:'x86_64'}:{})}));
 files.push({path:'manifest.json',size:bytes.length,mode:regular(file).mode&0o777,sha256:manifestSha256});
 let sourceArtifact;if(source){sourceArtifact={directoryRelative:project+'/'+m.version+'-source.tar.gz',sha256:await A.checksum(source),bytes:regular(source).size};}
 return publicDeclaration({id:project,version:m.version,arch:m.arch,launcherArchitectures,minimumMacOS:m.minimumMacOS,directoryRelative:project+'/'+m.version+'/'+m.arch,manifestRelative:'manifest.json',manifestSha256,sourceSha256:sourceArtifact?.sha256||manifestSha256,...(sourceArtifact?{sourceArtifact}:{sourceRelative:'manifest.json'}),files,notices:m.notices.map(n=>({...n,path:'files/'+n.path})),redistribution:'bundle'});
}

