import test from 'node:test';
import assert from 'node:assert/strict';
import {addLicense,addLicenses,includeLicenses,addCargoLicenses} from '../lib/licenses.mjs';
test('the shared licence functions never throw for unavailable inputs',t=>{
 t.mock.method(console,'log',()=>{});
 for(const operation of [()=>addLicense(undefined,undefined,undefined),()=>addLicenses(undefined,undefined,undefined),()=>includeLicenses(undefined,undefined),()=>addCargoLicenses(undefined,undefined,undefined)])assert.doesNotThrow(operation);
});
