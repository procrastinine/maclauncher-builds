process.env.MACLAUNCHER_PACKAGE_PRODUCER='1';
const Contract=require('../sources/maclauncher/src/modules/shared/runtime/package-contract.cjs');
module.exports={...Contract,packageRecord(record,options){const {build,...input}=record;const result=Contract.packageRecord(input,options);return build===undefined?result:Object.freeze({...result,build});}};
