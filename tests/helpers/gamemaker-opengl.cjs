const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../producers/included-helpers/gamemaker-opengl-helper');
const pins=require(path.join(root,'sources.json'));
function sourcePath(version){const pin=pins.find(item=>item.version===version);if(!pin)throw Error('Select a declared producer source profile.');const file=path.join(root,pin.sourceFile);if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==pin.sourceSha256)throw Error('Producer source changed.');return file;}
module.exports={sourcePath};
