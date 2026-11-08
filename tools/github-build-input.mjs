import './producer-environment.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
/** Inputs are verified by the shared dependency graph before a recipe starts. */
export async function githubBuildInput({pin,environment=process.env}){
 const input=preparedBuildInput(pin?.project,environment);
 if(!input)throw Error('The dependency graph did not prepare the Builds input: '+pin?.project);
 return input;
}
