import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const RUST_TOOLCHAIN='1.99.0';
/** Keep compiler source locations stable across runner and development caches. */
export function rustEnvironment({work,minimumMacOS,env=process.env}){
 const cargo=path.join(work,'cargo');
 const sysroot=execFileSync('rustc',['--print','sysroot'],{maxBuffer:Infinity,encoding:'utf8',env:{...env,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN}}).trim();
 const maps=[[work,'maclauncher-build'],[cargo,'cargo'],...(env.RUSTUP_HOME?[[env.RUSTUP_HOME,'rustup']]:[]),[sysroot,'rust-toolchain']];
 const inherited=env.CARGO_ENCODED_RUSTFLAGS?env.CARGO_ENCODED_RUSTFLAGS.split(String.fromCharCode(31)):(env.RUSTFLAGS||'').split(/\s+/).filter(Boolean);
 const result={...env,CARGO_HOME:cargo,RUSTUP_TOOLCHAIN:RUST_TOOLCHAIN,MACOSX_DEPLOYMENT_TARGET:minimumMacOS,CARGO_TARGET_DIR:path.join(work,'target'),CARGO_ENCODED_RUSTFLAGS:[...inherited,...maps.map(([from,to])=>'--remap-path-prefix='+from+'='+to)].join(String.fromCharCode(31))};
 delete result.RUSTFLAGS;
 for(const key of ['CFLAGS','CXXFLAGS'])result[key]=[env[key],...maps.map(([from,to])=>'-ffile-prefix-map='+from+'='+to)].filter(Boolean).join(' ');
 return result;
}
