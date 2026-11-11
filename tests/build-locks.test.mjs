import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {cargoLockManifest,nugetLockProject,swiftResolvedPins,resolveLocks,lockCache,lockedEnvironment} from '../tools/build-locks.mjs';
import {buildRecord} from '../lib/projects.mjs';

process.env.TMPDIR=fs.mkdtempSync(path.join(os.tmpdir(),'build-locks-'));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const crate=Buffer.from('serde 1.0.0 crate bytes');
const cargoLock=checksum=>'version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "n2",\n "serde",\n]\n\n'+
 '[[package]]\nname = "n2"\nversion = "0.1.0"\nsource = "git+https://github.com/evmar/n2?rev=b1fead52#b1fead52c1e2f6a6f0b4c1a1d1e2f3a4b5c6d7e8"\n\n'+
 '[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "'+checksum+'"\n';
const checkout=files=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lock-checkout-'));for(const [name,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});fs.writeFileSync(path.join(directory,name),text);}return directory;};
// The stand-in cargo stores each fetched crate where cargo's registry cache keeps it.
const cargoRun=calls=>(command,args,options)=>{calls.push({command,args,env:options.env});const cache=path.join(options.env.CARGO_HOME,'registry/cache/index.crates.io-1949cf8c6b5b557f');fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,'serde-1.0.0.crate'),crate);return '';};

test('a declared Cargo.lock is fetched through a manifest requiring every locked registry and Git package',()=>{
 const manifest=cargoLockManifest(cargoLock(sha(crate)));
 assert.match(manifest,/locked-0 = \{ package = "n2", git = "https:\/\/github.com\/evmar\/n2", rev = "b1fead52", default-features = false \}/);
 assert.match(manifest,/locked-1 = \{ package = "serde", version = "=1.0.0", default-features = false \}/);
 assert.doesNotMatch(manifest,/package = "app"/);
 const calls=[],directory=checkout({'locks/Cargo.lock':cargoLock(sha(crate))});
 assert.deepEqual(resolveLocks({project:'example',locks:[{tool:'cargo',file:'locks/Cargo.lock'}],directory,run:cargoRun(calls)}),[{tool:'cargo',file:'locks/Cargo.lock',cache:lockCache('cargo')}]);
 assert.deepEqual(calls.map(call=>[call.command,call.args[0],call.env.CARGO_HOME,call.env.CARGO_NET_OFFLINE]),[['cargo','fetch',lockCache('cargo'),'false']]);
 // The declared lock is the previous resolve of the generated manifest.
 assert.equal(fs.readFileSync(path.join(path.dirname(calls[0].args.at(-1)),'Cargo.lock'),'utf8'),cargoLock(sha(crate)));
});

test('a missing or edited lock fails, naming the package, the lock and the locked package',()=>{
 const directory=checkout({'locks/Cargo.lock':cargoLock('0'.repeat(64))});
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'cargo',file:'locks/absent.lock'}],directory,run:cargoRun([])}),/^Error: example: the cargo lock locks\/absent\.lock does not resolve: the file is missing$/);
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'cargo',file:'locks/Cargo.lock'}],directory,run:cargoRun([])}),/^Error: example: the cargo lock locks\/Cargo\.lock does not resolve: serde 1\.0\.0 differs from its locked checksum$/);
 // A failing tool's own message names what it rejected.
 const failing=()=>{throw Object.assign(Error('Command failed'),{stderr:'error: checksum for `serde v1.0.0` changed between lock files'});};
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'cargo',file:'locks/Cargo.lock'}],directory,run:failing}),/example: the cargo lock locks\/Cargo\.lock does not resolve: error: checksum for `serde v1\.0\.0` changed/);
});

test('a declared go.sum is fetched beside its go.mod and must already hold every checksum',()=>{
 const sum='example.com/a v1.0.0 h1:abc=\nexample.com/a v1.0.0/go.mod h1:def=\n',directory=checkout({'module/go.mod':'module example\n\ngo 1.21\n\nrequire example.com/a v1.0.0\n','module/go.sum':sum});
 const calls=[],run=(command,args,options)=>{calls.push({command,args,cwd:options.cwd,env:options.env});return '';};
 resolveLocks({project:'example',locks:[{tool:'go',file:'module/go.sum'}],directory,run});
 assert.deepEqual(calls.map(call=>[call.command,...call.args,call.env.GOMODCACHE,call.env.GOFLAGS]),[['go','mod','download','-json',lockCache('go'),'-mod=readonly']]);
 assert.equal(fs.readFileSync(path.join(calls[0].cwd,'go.mod'),'utf8'),fs.readFileSync(path.join(directory,'module/go.mod'),'utf8'));
 const adds=(command,args,options)=>{fs.appendFileSync(path.join(options.cwd,'go.sum'),'example.com/b v2.0.0 h1:ghi=\n');return '';};
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'go',file:'module/go.sum'}],directory,run:adds}),/example: the go lock module\/go\.sum does not resolve: the lock has no checksum for example\.com\/b v2\.0\.0/);
 const mismatch=()=>{throw Object.assign(Error('Command failed'),{stdout:'{\n\t"Path": "example.com/a",\n\t"Version": "v1.0.0",\n\t"Error": "verifying module: checksum mismatch"\n}\n'});};
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'go',file:'module/go.sum'}],directory,run:mismatch}),/does not resolve: example\.com\/a v1\.0\.0: verifying module: checksum mismatch/);
});

test('a declared NuGet lock is restored in locked mode through a project naming its direct references',()=>{
 const lock=JSON.stringify({version:1,dependencies:{'net10.0':{LibHac:{type:'Direct',requested:'[0.19.0, )',resolved:'0.19.0',contentHash:'abc='}},'net10.0/osx-arm64':{}}});
 const project=nugetLockProject(lock);
 assert.match(project,/<TargetFrameworks>net10\.0<\/TargetFrameworks>/);
 assert.match(project,/<RuntimeIdentifiers>osx-arm64<\/RuntimeIdentifiers>/);
 assert.match(project,/<PackageReference Include="LibHac" Version="\[0\.19\.0, \)" \/>/);
 const directory=checkout({'nuget/packages.lock.json':lock}),calls=[];
 resolveLocks({project:'example',locks:[{tool:'nuget',file:'nuget/packages.lock.json'}],directory,run:(command,args,options)=>{calls.push({command,args,env:options.env});return '';}});
 assert.deepEqual(calls[0].args.slice(2),['--locked-mode','--lock-file-path',path.join(directory,'nuget/packages.lock.json'),'--packages',lockCache('nuget'),'-maxCpuCount:1']);
 const edited=()=>{throw Object.assign(Error('Command failed'),{stderr:'error NU1403: Package content hash validation failed for LibHac.0.19.0. The package is different than the last restore.'});};
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'nuget',file:'nuget/packages.lock.json'}],directory,run:edited}),/example: the nuget lock nuget\/packages\.lock\.json does not resolve: error NU1403: Package content hash validation failed for LibHac\.0\.19\.0/);
});

const swiftLock=pins=>JSON.stringify({originHash:'0',pins,version:3});
const swiftPin=(identity,location,revision,version)=>({identity,kind:'remoteSourceControl',location,state:{revision,...(version?{version}:{})}});
// The stand-in Git answers for a repository whose tree records one relative submodule.
const swiftRun=(calls,{tagged='a'.repeat(40)}={})=>(command,args)=>{
 calls.push([command,...args]);
 if(args[2]==='rev-parse')return tagged+'\n';
 if(args[2]==='ls-tree'&&args[4]==='.gitmodules')return args[3]==='a'.repeat(40)?'100644 blob 1\t.gitmodules\n':'';
 if(args[2]==='config')return 'submodule.mlx.path Source/Cmlx/mlx\nsubmodule.mlx.url ../mlx\n';
 if(args[2]==='ls-tree')return '160000 commit '+'b'.repeat(40)+'\tSource/Cmlx/mlx\n';
 return '';
};
test('a declared Package.resolved fetches each pinned revision, its version tag and its submodule commits, and Git reads only those',()=>{
 const pins=[swiftPin('mlx-swift','https://github.com/ml-explore/mlx-swift','a'.repeat(40),'0.31.6')];
 assert.deepEqual(swiftResolvedPins(swiftLock(pins)),[{location:'https://github.com/ml-explore/mlx-swift',revision:'a'.repeat(40),tag:'0.31.6'}]);
 const directory=checkout({'swift/Package.resolved':swiftLock(pins)}),calls=[];
 resolveLocks({project:'example',locks:[{tool:'swiftpm',file:'swift/Package.resolved'}],directory,run:swiftRun(calls)});
 assert.deepEqual(calls.filter(call=>call[3]==='fetch').map(call=>call.slice(6)),[
  ['https://github.com/ml-explore/mlx-swift','+'+'a'.repeat(40)+':refs/locked/'+'a'.repeat(40),'+refs/tags/0.31.6:refs/tags/0.31.6'],
  ['https://github.com/ml-explore/mlx','+'+'b'.repeat(40)+':refs/locked/'+'b'.repeat(40)]]);
 const mirrors=JSON.parse(fs.readFileSync(path.join(lockCache('swiftpm'),'mirrors.json'),'utf8')),first=Number(process.env.GIT_CONFIG_COUNT)||0;
 assert.deepEqual(Object.keys(mirrors),['https://github.com/ml-explore/mlx-swift','https://github.com/ml-explore/mlx']);
 assert.ok(Object.values(mirrors).every(mirror=>path.dirname(mirror)===lockCache('swiftpm')));
 assert.deepEqual(lockedEnvironment({locks:[{tool:'swiftpm',file:'swift/Package.resolved'}]}),{GIT_ALLOW_PROTOCOL:'file',GIT_CONFIG_COUNT:String(first+2),
  ['GIT_CONFIG_KEY_'+first]:'url.'+mirrors['https://github.com/ml-explore/mlx-swift']+'.insteadOf',['GIT_CONFIG_VALUE_'+first]:'https://github.com/ml-explore/mlx-swift',
  ['GIT_CONFIG_KEY_'+(first+1)]:'url.'+mirrors['https://github.com/ml-explore/mlx']+'.insteadOf',['GIT_CONFIG_VALUE_'+(first+1)]:'https://github.com/ml-explore/mlx'});
});
test('a Package.resolved pin without an exact remote revision, or with a moved version tag, fails',()=>{
 for(const pin of [swiftPin('local','/tmp/local','a'.repeat(40)),swiftPin('branch','https://github.com/example/branch','main'),{...swiftPin('registry','https://example.com/registry','a'.repeat(40)),kind:'registry'}])
  assert.throws(()=>swiftResolvedPins(swiftLock([pin])),new RegExp('^Error: '+pin.identity+' is not a remote Git repository at an exact revision$'));
 assert.throws(()=>swiftResolvedPins('{"version":1,"object":{"pins":[]}}'),/not a version 2 or 3 Package\.resolved/);
 const directory=checkout({'swift/Package.resolved':swiftLock([swiftPin('mlx-swift','https://github.com/ml-explore/mlx-swift','a'.repeat(40),'0.31.6')])});
 assert.throws(()=>resolveLocks({project:'example',locks:[{tool:'swiftpm',file:'swift/Package.resolved'}],directory,run:swiftRun([],{tagged:'c'.repeat(40)})}),
  /example: the swiftpm lock swift\/Package\.resolved does not resolve: https:\/\/github\.com\/ml-explore\/mlx-swift 0\.31\.6 is not the locked revision a{40}$/);
});
test('a build declares each lock once by tool and file, and its compile reads the lock caches offline',()=>{
 const project=build=>({id:'example',producer:{kind:'maclauncher',sourceDirectory:'producers/example'},packageProfiles:[{version:'1.0.0'}],build:{version:'1.0.0',command:'tools/build-example.mjs',architectures:['arm64'],...build}});
 const locks=[{tool:'cargo',file:'a/Cargo.lock'},{tool:'go',file:'b/go.sum'},{tool:'nuget',file:'c/packages.lock.json'}];
 assert.deepEqual(buildRecord(project({locks})).locks,locks);
 assert.deepEqual(buildRecord(project({locks:[{tool:'swiftpm',file:'d/Package.resolved'}]})).locks,[{tool:'swiftpm',file:'d/Package.resolved'}]);
 for(const invalid of [[],[{tool:'npm',file:'package-lock.json'}],[{tool:'go',file:'b/go.mod'}],[{tool:'swiftpm',file:'d/Package.swift'}],[{tool:'cargo',file:'../Cargo.lock'}],[{tool:'cargo',file:'a/Cargo.lock'},{tool:'cargo',file:'a/Cargo.lock'}],[{tool:'cargo',file:'a/Cargo.lock',pointer:''}]])
  assert.throws(()=>buildRecord(project({locks:invalid})),/Invalid GitHub build locks/);
 assert.deepEqual(lockedEnvironment({locks}),{CARGO_HOME:lockCache('cargo'),CARGO_NET_OFFLINE:'true',GOMODCACHE:lockCache('go'),GOPROXY:'off',GOFLAGS:'-mod=readonly',NUGET_PACKAGES:lockCache('nuget')});
 assert.deepEqual(lockedEnvironment({}),{});
});
