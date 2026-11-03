import fs from 'node:fs';
import path from 'node:path';
import {resolveProject,readProjects} from './projects.mjs';
import {version} from './project-identity.mjs';
import {ownedPackageSource,plainSemanticVersion} from './source-ownership.mjs';

const root=path.resolve(import.meta.dirname,'..');
/** Explicit package labels are preserved independently of source pins. */
export function releaseVersion(project,value,directory=root){
 const registered=resolveProject(project,directory,{resolvePins:false});
 const profiles=registered.packageProfiles||[];
 if(value===undefined){if(profiles.length!==1)throw Error('Select an explicitly declared release version.');value=profiles[0].version;}
 version(value);
 if(!profiles.some(profile=>profile.version===value))throw Error('Release version is not declared in the project package profiles.');
 return value;
}

/** Ownership guides suggestions, while registered explicit labels remain valid. */
export function buildReleaseVersion(project,value,directory=root){
 return releaseVersion(project,value,directory);
}

/** Low-level archive/catalog tools also enforce registered product ownership. */
export function outputVersion(project,value,directory=root){
 const registry=readProjects(directory,{resolvePins:false}),registered=registry.projects.find(row=>row.id===project);
 if(registered&&ownedPackageSource(registered,registry.repository,directory)&&!plainSemanticVersion(value))buildReleaseVersion(project,value,directory);
 return value;
}
