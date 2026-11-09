const {appRequire}=require('../tools/app-source.mjs');
process.env.MACLAUNCHER_PACKAGE_PRODUCER='1';
const Contract=appRequire('src/modules/shared/runtime/package-contract.cjs');
module.exports={...Contract,packageRecord(record,options){const {build,...input}=record;const result=Contract.packageRecord(input,options);return build===undefined?result:Object.freeze({...result,build});}};
