import './producer-environment.mjs';
import libffi from '../producers/dependencies/libffi.json' with {type:'json'};
import {sourceRevision} from '../lib/pins.mjs';
import {verifyPreparedPayload} from './prepared-build-inputs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),B=require('../lib/package-format.cjs'),{validateDeclaration}=require('../lib/package-contract.cjs');

/** Read the sealed Linux-built Android libffi input through its ordinary inventory. */
export function readArtFfiInput(input){
 if(!path.isAbsolute(input||''))throw Error('The ART supplier requires a sealed Linux libffi input directory.');
 const declaration=JSON.parse(fs.readFileSync(path.join(input,'declaration.json'))),payload=path.join(input,'payload');
 validateDeclaration(declaration);
 verifyPreparedPayload(payload,declaration);

 for(const relative of ['lib/libffi.a','include/ffi.h','include/ffitarget.h'])B.readRegular(path.join(payload,relative),Infinity);
 return {archive:path.join(payload,'lib/libffi.a'),include:path.join(payload,'include'),revision:sourceRevision(libffi)};
}
