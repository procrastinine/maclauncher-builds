import fs from 'node:fs';
import path from 'node:path';

function replace(source,before,after){
 if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 Mach-O linkedit boundary changed: '+before.slice(0,80));
 return source.replace(before,after);
}
export function applyNidOverlay(root){
 const file=path.join(root,'core/libs/nid/src/MachONidPatcher.cpp');
 let source=fs.readFileSync(file,'utf8');
 const start=source.indexOf('void WriteLinkeditData('),end=source.indexOf('\nvoid PatchChainedImports(',start);
 if(start<0||end<0)throw Error('The AnyPS5 Mach-O linkedit writer differs from its pinned source.');
 let writer=source.slice(start,end);
 writer=replace(writer,'    const auto oldSize = Read<std::uint32_t>(binary, location.SizeField);',
  '    const auto oldSize = Read<std::uint32_t>(binary, location.SizeField);\n    RequireRange(binary, oldOffset, oldSize);');
 writer=replace(writer,'        Write(binary, location.SizeField, static_cast<std::uint32_t>(trie.size()));','        Write(binary, location.SizeField, oldSize);');
 const growth=writer.indexOf('    if (segment.FileOffset + segment.FileSize != binary.size())');
 const finish=writer.lastIndexOf('\n}');
 if(growth<0||finish<growth)throw Error('The AnyPS5 Mach-O linkedit growth boundary changed.');
 writer=writer.slice(0,growth)+fs.readFileSync(new URL('./LinkeditGrowth.inc',import.meta.url),'utf8').trimEnd()+writer.slice(finish);
 fs.writeFileSync(file,source.slice(0,start)+writer+source.slice(end));
}
