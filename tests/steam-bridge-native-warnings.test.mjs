import test from 'node:test';import assert from 'node:assert/strict';import {warnNativeOutput} from '../producers/steam-bridge/build.mjs';
test('derived symbol and architecture checks warn without blocking package output',()=>{
 const warnings=[];warnNativeOutput({architecture:'arm64',actualArchitecture:'arm64 x86_64',unresolved:'    _steamclient_unknown'},line=>warnings.push(line));assert.equal(warnings.length,2);
 warnNativeOutput({architecture:'arm64',actualArchitecture:'arm64',unresolved:'    _malloc'},line=>assert.fail(line));
});
