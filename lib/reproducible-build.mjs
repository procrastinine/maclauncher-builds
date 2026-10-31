import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** Tar timestamps and compiler time macros follow the selected recipe commit. */
export function sourceDateEpoch(directory, revision = 'HEAD') {
 if (!/^(?:HEAD|[a-f0-9]{40})$/.test(revision)) throw Error('Select an exact source commit for the build epoch.');
 const value = execFileSync('git', ['-C', directory, 'show', '-s', '--format=%ct', revision], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('Source commit has no usable timestamp.');
 return Number(value);
}

/** Plain source trees without Git metadata use the portable archive epoch. */
export function reproducibleEnvironment(directory, environment = process.env) {
 return {...environment, SOURCE_DATE_EPOCH:String(fs.existsSync(path.join(directory,'.git')) ? sourceDateEpoch(directory) : 0),
  ZERO_AR_DATE:'1', TZ:'UTC', LC_ALL:'C', PYTHONHASHSEED:'0'};
}

/** Tool versions are observations; no host paths or wall-clock values are retained. */
export function buildToolchain(environment = process.env) {
 const read = (command,args) => {try{return execFileSync(command,args,{env:environment,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return undefined;}};
 const clang = read('/usr/bin/xcrun',['clang','--version'])?.split('\n')[0];
 const xcode = read('/usr/bin/xcodebuild',['-version']);
 const sdk = read('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-version']);
 return {node:process.versions.node,zlib:process.versions.zlib,...(clang?{clang}:{}),...(xcode?{xcode}:{}),...(sdk?{macosSDK:sdk}:{})};
}
