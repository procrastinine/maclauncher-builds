// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {sourceRevision} from '../../../../../../../lib/pins.mjs';
import {source} from './moltenvk-scene-overlay.mjs';
import {prepareSourceTree,writeChanged} from './source-files.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const profile=source.dependencies.find(item=>item.id==='SPIRV-Cross');
// Apache-2.0 adaptation of steamac c353f087e225866aca483ecc69ebc7c58df3c766.
// Author: steamac <steamac@localhost>, 2026-10-06.
// https://github.com/fxgl/steamac/blob/32a66354a24cc62d4c9ec1d263c5df7a0b1e1d7e/host/moltenvk/patches/spirv-cross/0026-Copies-of-access-chain-pointers-are-the-same-lvalue.patch
// Original SPIRV-Cross copyright and license notices remain in the projected files.
export function copyObjectSources(readSource){
 const files=new Map();
 const edit=(file,from,to)=>{const text=readSource(file);if(text.split(from).length!==2)throw Error('SPIRV-Cross source anchor changed: '+file);files.set(file,text.replace(from,to));};
 const scope='\t\tif (access_chain_expressions.count(args[2]))\n\t\t\taccess_chain_expressions.insert(args[1]);';
 edit('spirv_cross.cpp',scope,
  '\t\tif (access_chain_expressions.count(args[2]))\n\t\t{\n\t\t\taccess_chain_expressions.insert(args[1]);\n'+
  '\t\t\t// Stores through a copied access chain still write its backing variable.\n'+
  '\t\t\tauto &e = compiler.set<SPIRExpression>(args[1], "", args[0], true);\n'+
  '\t\t\te.loaded_from = var ? VariableID(var->self) : VariableID(0);\n'+
  '\t\t\tcompiler.ir.ids[args[1]].set_allow_type_rewrite();\n\t\t}');
 const dependencies='\t\t\t\te.implied_read_expressions = rhs_expr->implied_read_expressions;\n\t\t\t\te.expression_dependencies = rhs_expr->expression_dependencies;';
 edit('spirv_glsl.cpp',dependencies,dependencies+'\n\t\t\t\tif (pointer && rhs_expr->access_chain)\n\t\t\t\t\te.access_chain = true;');
 return files;
}
// Apache-2.0 adaptation of steamac 93761ea526c1d653e621b4f4df9f2c87e3f50832.
// Author: steamac <steamac@localhost>.
// https://github.com/fxgl/steamac/blob/32a66354a24cc62d4c9ec1d263c5df7a0b1e1d7e/host/moltenvk/patches/spirv-cross/0023-MSL-No-__restrict-on-buffers-that-share-an-argument-.patch
export function overlappingBindingSources(readSource){
 const files=new Map();let msl=readSource('spirv_msl.cpp');
 const edit=(from,to)=>{if(msl.split(from).length!==2)throw Error('SPIRV-Cross overlapping-binding anchor changed');msl=msl.replace(from,to);};
 const qualifier='const char *CompilerMSL::to_restrict(uint32_t id, bool space)\n{';
 edit(qualifier,qualifier+'\n\tif (argument_buffer_overlapping_vars.count(id))\n\t\treturn "";');
 const analysis='void CompilerMSL::analyze_argument_buffers()\n{';
 edit(analysis,analysis+'\n\targument_buffer_overlapping_vars.clear();');
 const overlap='\t\t\t\tset_extended_decoration(r2.var->self, SPIRVCrossDecorationOverlappingBinding, r2.overlapping_var_id);';
 edit(overlap,overlap+'\n\t\t\t\targument_buffer_overlapping_vars.insert(r2.overlapping_var_id);\n\t\t\t\targument_buffer_overlapping_vars.insert(r2.var->self);');
 files.set('spirv_msl.cpp',msl);
 const header=readSource('spirv_msl.hpp'),member='\tSmallVector<uint32_t> buffer_aliases_discrete;';
 if(header.split(member).length!==2)throw Error('SPIRV-Cross overlapping-binding member anchor changed');
 files.set('spirv_msl.hpp',header.replace(member,member+'\n\t// Rebuilt at argument-buffer analysis; retained through emission pass resets.\n\tstd::unordered_set<uint32_t> argument_buffer_overlapping_vars;'));
 return files;
}
/** Export the declared compiler pin, then adapt only the owned projection. */
export function prepareSpirvCrossSource({repository,work}){
 repository=fs.realpathSync(repository);work=path.resolve(work);
 if(work===repository||work.startsWith(repository+path.sep)||repository.startsWith(work+path.sep))throw Error('SPIRV-Cross source and owned build directories must be disjoint');
 const revision=sourceRevision(profile),directory=path.join(work,'spirv-cross-source');fs.mkdirSync(work,{recursive:true});
 const archive=path.join(work,'spirv-cross-upstream.tar');let files;
 execFileSync('git',['-C',repository,'archive','--format=tar','--output='+archive,revision],{env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
 try{prepareSourceTree(directory,temporary=>{
  execFileSync('/usr/bin/tar',['-xf',archive,'-C',temporary]);
  const read=file=>fs.readFileSync(path.join(temporary,file),'utf8');
  files=new Map([...copyObjectSources(read),...overlappingBindingSources(read)]);
  for(const[file,text]of files)writeChanged(path.join(temporary,file),text);
 });}finally{fs.unlinkSync(archive);}
 return {directory,inputs:{id:profile.id,repository:profile.repository,revision,files:[...files].map(([file,text])=>({file,sha256:digest(text)}))}};
}
