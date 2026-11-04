import test from 'node:test';
import assert from 'node:assert/strict';
import {addLicense,addLicenses,includeLicenses,addCargoLicenses} from '../lib/licenses.mjs';
test('the shared licence functions never throw for unavailable inputs',t=>{
 t.mock.method(console,'log',()=>{});
 const bad=[undefined,Symbol('directory'),{toString(){throw Error('conversion');}},Buffer.from('.'),new URL('file:///missing')];
 for(const value of bad){for(const operation of [()=>addLicense(undefined,undefined,undefined),()=>addLicenses(undefined,undefined,undefined),()=>includeLicenses(undefined,undefined),()=>addCargoLicenses(undefined,undefined,undefined)])assert.doesNotThrow(operation);
 for(const operation of [()=>addLicense(value,value,value),()=>addLicenses(value,value,value),()=>includeLicenses(value,value),()=>addCargoLicenses(value,value,value)])assert.doesNotThrow(operation);
 }
 t.mock.method(console,'log',()=>{throw Error('logging');});
 for(const operation of [()=>addLicense(),()=>includeLicenses(),()=>addLicenses(),()=>addCargoLicenses()])assert.doesNotThrow(operation);
});
