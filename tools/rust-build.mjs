import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {sourceNotices} from './build-source.mjs';
export const RUST_TOOLCHAIN='1.99.0';
/** License files for statically linked Cargo dependencies and the Rust library. */
export function rustNotices({source,output,target,licenseInputs=[],env={...process.env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN}}){
 const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1',...(target?['--filter-platform',target]:[])],{cwd:source,env,encoding:'utf8',maxBuffer:Infinity})),notices=[];
 if(target&&!Array.isArray(metadata.resolve?.nodes))throw Error('Cargo target dependency graph is missing.');
 const selected=target?new Set(metadata.resolve.nodes.map(node=>node.id)):null;
 const copy=(file,relative,name,license,sourceUrl)=>notices.push({file,name,license,sourceUrl});
 for(const item of metadata.packages.filter(item=>item.source?.startsWith('registry+')&&(!selected||selected.has(item.id)))){
  const directory=path.dirname(item.manifest_path),files=sourceNotices(directory,{name:item.name,repository:'https://crates.io/crates/'+item.name+'/'+item.version}).map(row=>path.relative(directory,row.file));
  if(!files.length){
   const selected=licenseInputs.filter(row=>row.name===item.name&&row.version===item.version);
   if(!selected.length){console.warn('No license text supplied for '+item.name+' '+item.version);continue;}
   if(!selected[0]?.files?.length)console.warn('No license text supplied for '+item.name+' '+item.version);
   for(const entry of selected[0]?.files||[]){
    copy(entry.file,'crates/'+item.name+'-'+item.version+'/'+path.basename(entry.file),item.name+' '+item.version,item.license,entry.sourceUrl);
   }
   continue;
  }
  for(const file of files)copy(path.join(directory,file),'crates/'+item.name+'-'+item.version+'/'+file,item.name+' '+item.version,item.license||'See included license','https://crates.io/crates/'+item.name+'/'+item.version);
 }
 const sysroot=execFileSync('rustc',['--print','sysroot'],{maxBuffer:Infinity,encoding:'utf8',env}).trim();
 // Official rustup distributions and Homebrew preserve these original notices.
 const rustSource='https://github.com/rust-lang/rust/tree/'+/commit-hash: ([a-f0-9]{40})/.exec(execFileSync('rustc',['-vV'],{maxBuffer:Infinity,encoding:'utf8',env}))[1];
 for(const [file,name] of [['LICENSE-MIT','MIT.txt'],['LICENSE-APACHE','Apache-2.0.txt']]){
  const input=[sysroot,path.join(sysroot,'share/doc/rust'),path.join(sysroot,'share/doc/rustc')].map(root=>path.join(root,file))
   .concat([path.join(sysroot,'share/doc/rust/licenses',name),path.join(sysroot,'share/doc/rustc/licenses',name)]).find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
  if(input)copy(input,'rust/'+file,'Rust standard library','MIT OR Apache-2.0',rustSource);
  else console.warn('No license text supplied for Rust standard library: '+file);
 }
 for(const root of [path.join(sysroot,'share/doc/rust'),path.join(sysroot,'share/doc/rustc')])if(fs.existsSync(path.join(root,'COPYRIGHT-library.html'))){copy(path.join(root,'COPYRIGHT-library.html'),'rust/COPYRIGHT-library.html','Rust standard library dependencies','See included notices',rustSource);break;}
 return notices;
}

/** Keep compiler source locations stable across runner and development caches. */
export function rustEnvironment({work,minimumMacOS,env=process.env}){
 const cargo=env.CARGO_HOME||path.join(os.homedir(),'.cargo');
 const sysroot=execFileSync('rustc',['--print','sysroot'],{maxBuffer:Infinity,encoding:'utf8',env:{...env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN}}).trim();
 const maps=[[work,'maclauncher-build'],[cargo,'cargo'],...(env.RUSTUP_HOME?[[env.RUSTUP_HOME,'rustup']]:[]),[sysroot,'rust-toolchain']];
 const inherited=env.CARGO_ENCODED_RUSTFLAGS?env.CARGO_ENCODED_RUSTFLAGS.split(String.fromCharCode(31)):(env.RUSTFLAGS||'').split(/\s+/).filter(Boolean);
 const result={...env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN,MACOSX_DEPLOYMENT_TARGET:minimumMacOS,CARGO_TARGET_DIR:path.join(work,'target'),CARGO_ENCODED_RUSTFLAGS:[...inherited,...maps.map(([from,to])=>'--remap-path-prefix='+from+'='+to)].join(String.fromCharCode(31))};
 delete result.RUSTFLAGS;
 for(const key of ['CFLAGS','CXXFLAGS'])result[key]=[env[key],...maps.map(([from,to])=>'-ffile-prefix-map='+from+'='+to)].filter(Boolean).join(' ');
 return result;
}
