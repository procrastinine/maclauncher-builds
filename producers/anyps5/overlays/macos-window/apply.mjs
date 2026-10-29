import fs from 'node:fs';
import path from 'node:path';

function replaceOnce(text,before,after,file) {
 const index=text.indexOf(before);
 if(index<0||index!==text.lastIndexOf(before))throw Error('AnyPS5 Darwin window overlay does not match '+file);
 return text.replace(before,after);
}

function wrap(text,signature,file) {
 const start=text.indexOf(signature);
 if(start<0||start!==text.lastIndexOf(signature))throw Error('AnyPS5 Darwin UI function does not match '+file+': '+signature);
 const open=text.indexOf('{',start);
 let depth=1,end=open+1;
 for(;end<text.length&&depth!==0;end++) {
  if(text[end]==='{')depth++;
  else if(text[end]==='}')depth--;
 }
 if(depth!==0)throw Error('AnyPS5 Darwin UI function is unterminated: '+file);
 const body=text.slice(open+1,end-1);
 return text.slice(0,open+1)+'\n    OnMainThread([&] {'+body+'    });\n'+text.slice(end-1);
}

export function applyWindowOverlay(projectionRoot) {
 const changes=[];
 const edit=(relative,adapt)=>{
  const target=path.join(projectionRoot,relative),before=fs.readFileSync(target,'utf8'),after=adapt(before,relative);
  if(before!==after){fs.writeFileSync(target,after);changes.push(relative);}
 };
 edit('core/libs/prx/libkernel/Pthread/src/Thread.cpp',(text,file)=>{
  text='#ifdef __APPLE__\nextern "C" bool Aps5IsGuestMainThread_nid_no_patch();\n#endif\n'+text;
  return replaceOnce(text,'#else\n    return std::this_thread::get_id() == initialThreadId;',
   '#elif defined(__APPLE__)\n    return Aps5IsGuestMainThread_nid_no_patch();\n#else\n    return std::this_thread::get_id() == initialThreadId;',file);
 });
 edit('core/libs/prx/libSceVideoOut/src/DisplayWindow.cpp',(text,file)=>{
  text='#include "prx/libSceVideoOut/include/MainThread.hpp"\n'+text;
  for(const signature of ['void DisplayWindow::Ensure(', 'void DisplayWindow::Destroy()', 'void DisplayWindow::ToggleFullscreen()', 'void DisplayWindow::DrawableSize(', 'void DisplayWindow::UpdateTitle()'])text=wrap(text,signature,file);
  return text;
 });
 edit('core/libs/prx/libSceVideoOut/src/PadInput.cpp',(text,file)=>{
  text='#include "prx/libSceVideoOut/include/MainThread.hpp"\n'+text;
  for(const signature of ['void PadInput::openAvailableControllers()', 'PadInput::~PadInput()'])text=wrap(text,signature,file);
  return text;
 });
 return changes;
}
