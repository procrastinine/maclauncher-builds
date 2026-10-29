import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {releaseVersion} from '../lib/package-version.mjs';
const root=path.resolve(import.meta.dirname,'..');
export function checkReleaseVersions(directory=root){let records=0;for(const name of fs.readdirSync(path.join(directory,'catalogs')).filter(name=>name.endsWith('.json')&&name!=='index.json')){const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',name)));for(const record of catalog.packages){releaseVersion(record.id,record.version,directory);records++;}}return {records};}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(checkReleaseVersions()));}catch(error){console.error(error.message);process.exitCode=1;}}
