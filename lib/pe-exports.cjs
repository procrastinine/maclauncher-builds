const {appRequire}=require('../tools/app-source.mjs');
process.env.MACLAUNCHER_PACKAGE_PRODUCER = '1';
module.exports = appRequire('src/modules/shared/runtime/pe-exports.js');
