import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
export const RUST_TOOLCHAIN='1.99.0';
/** License files for statically linked Cargo dependencies and the Rust library. */
export function rustNotices({source,output,env={...process.env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN}}){
 const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1'],{cwd:source,env,encoding:'utf8',maxBuffer:16<<20})),notices=[];
 const copy=(file,relative,name,license,sourceUrl)=>{const target=path.join(output,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);fs.chmodSync(target,0o644);notices.push({file:target,name,license,sourceUrl});};
 for(const item of metadata.packages.filter(item=>item.source?.startsWith('registry+'))){
  const directory=path.dirname(item.manifest_path),files=fs.readdirSync(directory).filter(name=>/^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)([._-]|$)/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
  if(!files.length)throw Error('Missing license for '+item.name+' '+item.version);
  for(const file of files)copy(path.join(directory,file),'crates/'+item.name+'-'+item.version+'/'+file,item.name+' '+item.version,item.license||'See included license','https://crates.io/crates/'+item.name+'/'+item.version);
 }
 const sysroot=execFileSync('rustc',['--print','sysroot'],{encoding:'utf8',env}).trim();
 // Official rustup distributions and Homebrew preserve these original notices.
 const licenseRoot=[sysroot,path.join(sysroot,'share/doc/rust'),path.join(sysroot,'share/doc/rustc')].find(root=>fs.existsSync(path.join(root,'LICENSE-MIT'))&&fs.existsSync(path.join(root,'LICENSE-APACHE')));
 const rustSource='https://github.com/rust-lang/rust/tree/'+/commit-hash: ([a-f0-9]{40})/.exec(execFileSync('rustc',['-vV'],{encoding:'utf8',env}))[1];
 const docLicenses=[path.join(sysroot,'share/doc/rust/licenses'),path.join(sysroot,'share/doc/rustc/licenses')].find(root=>fs.existsSync(path.join(root,'MIT.txt'))&&fs.existsSync(path.join(root,'Apache-2.0.txt')));
 if(!licenseRoot&&!docLicenses)throw Error('Rust standard-library license files are missing from this toolchain.');
 for(const [file,name] of [['LICENSE-MIT','MIT.txt'],['LICENSE-APACHE','Apache-2.0.txt']])copy(path.join(licenseRoot||docLicenses,licenseRoot?file:name),'rust/'+file,'Rust standard library','MIT OR Apache-2.0',rustSource);
 for(const root of [path.join(sysroot,'share/doc/rust'),path.join(sysroot,'share/doc/rustc')])if(fs.existsSync(path.join(root,'COPYRIGHT-library.html'))){copy(path.join(root,'COPYRIGHT-library.html'),'rust/COPYRIGHT-library.html','Rust standard library dependencies','See included notices',rustSource);break;}
 return notices;
}

/** Keep compiler source locations stable across runner and development caches. */
export function rustEnvironment({work,minimumMacOS,env=process.env}){
 const cargo=env.CARGO_HOME||path.join(os.homedir(),'.cargo');
 const maps=[[work,'maclauncher-build'],[cargo,'cargo']];
 const inherited=env.CARGO_ENCODED_RUSTFLAGS?env.CARGO_ENCODED_RUSTFLAGS.split(String.fromCharCode(31)):(env.RUSTFLAGS||'').split(/\s+/).filter(Boolean);
 const result={...env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN,MACOSX_DEPLOYMENT_TARGET:minimumMacOS,CARGO_TARGET_DIR:path.join(work,'target'),CARGO_ENCODED_RUSTFLAGS:[...inherited,...maps.map(([from,to])=>'--remap-path-prefix='+from+'='+to)].join(String.fromCharCode(31))};
 delete result.RUSTFLAGS;
 for(const key of ['CFLAGS','CXXFLAGS'])result[key]=[env[key],...maps.map(([from,to])=>'-ffile-prefix-map='+from+'='+to)].filter(Boolean).join(' ');
 return result;
}
