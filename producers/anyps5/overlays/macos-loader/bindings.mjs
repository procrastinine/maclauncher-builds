import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source,before,after) {
  if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('AnyPS5 Mach-O binding boundary changed: '+before.slice(0,80));
  return source.replace(before,after);
}
export async function applyBindingsOverlay(root) {
  const changed=[];
  const edit=async(relative,transform)=>{
    const file=path.join(root,relative);
    await fs.writeFile(file,transform(await fs.readFile(file,'utf8')));changed.push(relative);
  };
  await edit('core/relinker/elfpatcher/include/elfpatcher/macos/MacOsImage.hpp',source=>{
    source=replace(source,'    bool Weak = false;\n};','    bool Weak = false;\n    std::int32_t DylibOrdinal = -2;\n};');
    return replace(source,'    std::int64_t Addend = 0;\n};\n\nstruct MacOsTlsExport', '    std::int64_t Addend = 0;\n    std::int32_t DylibOrdinal = -2;\n    bool Weak = false;\n};\n\nstruct MacOsTlsExport');
  });
  await edit('core/relinker/elfpatcher/include/elfpatcher/general/GuestModuleWriter.hpp',source=>{
    source=replace(source,'#include <functional>','#include <functional>\n#include <map>');
    return replace(source,'const std::function<void(std::string_view)>& message = {}) const;\n};','const std::function<void(std::string_view)>& message = {}, const std::map<std::size_t, std::int32_t>& bindOrdinals = {}) const;\n};');
  });
  await edit('core/relinker/relinker/src/guest/GuestModuleBuilder.cpp',source=>{
    source=replace(source,'    std::vector<std::set<std::size_t>> dependencies(images.size());','    std::vector<std::set<std::size_t>> dependencies(images.size());\n    std::vector<std::map<std::size_t, std::size_t>> importProviders(images.size());');
    source=replace(source,'            if (provider != nullptr) {\n                if ((symbol.Info', '            if (provider != nullptr) {\n                if (macos) importProviders[index].emplace(symbolIndex, provider->Provider);\n                if ((symbol.Info');
    source=replace(source,'            std::vector<std::string> needed;\n            for (const auto dependency : dependencies[index]) {','            std::vector<std::string> needed;\n            std::map<std::size_t, std::int32_t> providerOrdinals;\n            for (const auto dependency : dependencies[index]) {\n                providerOrdinals.emplace(dependency, static_cast<std::int32_t>(needed.size() + 2));');
    source=replace(source,'            const auto directory = image.SourcePath.parent_path();',`            std::map<std::size_t, std::int32_t> bindOrdinals;
            if (macos) {
                for (const auto& [symbol, provider] : importProviders[index]) {
                    if (provider == index) bindOrdinals.emplace(symbol, 0);
                    else if (const auto found = providerOrdinals.find(provider); found != providerOrdinals.end()) bindOrdinals.emplace(symbol, found->second);
                }
            }
            const auto directory = image.SourcePath.parent_path();`);
    return replace(source,'WriteMacOs(image, needed, guestRunPath, message)', 'WriteMacOs(image, needed, guestRunPath, message, bindOrdinals)');
  });
  await edit('core/relinker/elfpatcher/src/macos/MacOsGuestModuleWriter.cpp',source=>{
    source=replace(source,'const std::function<void(std::string_view)>& message) const {','const std::function<void(std::string_view)>& message, const std::map<std::size_t, std::int32_t>& bindOrdinals) const {');
    source=replace(source,'    const auto tls = std::find_if(',`    const auto importOrdinal = [&](std::size_t symbol) {
        const auto found = bindOrdinals.find(symbol);
        return found == bindOrdinals.end() ? std::int32_t{-2} : found->second;
    };
    const auto tls = std::find_if(`);
    source=replace(source,'input.TlsImports.push_back({"_" + DynamicName(guest, symbolIndex), rva, type == 16, static_cast<std::int64_t>(addend)});','input.TlsImports.push_back({"_" + DynamicName(guest, symbolIndex), rva, type == 16, static_cast<std::int64_t>(addend), importOrdinal(symbolIndex), (symbol.Info >> 4) == 2});');
    return replace(source,'input.Binds.push_back({"_" + name, rva, static_cast<std::int64_t>(addend), (symbol.Info >> 4) == 2});','input.Binds.push_back({"_" + name, rva, static_cast<std::int64_t>(addend), (symbol.Info >> 4) == 2, importOrdinal(symbolIndex)});');
  });
  await edit('core/relinker/elfpatcher/src/macos/MacOsImage.cpp',source=>{
    source=replace(source,'#include <map>','#include <map>\n#include <tuple>');
    source=replace(source,'constexpr std::uint8_t BindSpecialDylibFlatLookup = 0x0e;', 'constexpr std::uint8_t BindSpecialDylibFlatLookup = 0x0e;\nconstexpr std::uint8_t BindOpcodeSetDylibOrdinalImm = 0x10;\nconstexpr std::uint8_t BindOpcodeSetDylibOrdinalUleb = 0x20;');
    source=replace(source,'    std::vector<Segment> segments;\n    if (input.Executable)',`    const auto libraryOrdinal = [&](const std::string& library) {
        auto found = std::find(input.Dylibs.begin(), input.Dylibs.end(), library);
        if (found == input.Dylibs.end()) {
            input.Dylibs.push_back(library);
            found = std::prev(input.Dylibs.end());
        }
        return static_cast<std::int32_t>(found - input.Dylibs.begin() + 2);
    };
    for (auto& binding : input.Binds)
        if (binding.Symbol == "_Aps5GuestTlsGetAddr_nid_no_patch") binding.DylibOrdinal = libraryOrdinal("@rpath/libkernel.prx");
    std::vector<Segment> segments;
    if (input.Executable)`);
    source=replace(source,'    std::map<std::string, std::uint64_t> tlsImportSlots;\n    for (const auto& import : input.TlsImports) tlsImportSlots.emplace(import.Symbol, 0);','    std::map<std::tuple<std::string, std::int32_t, bool>, std::uint64_t> tlsImportSlots;\n    for (const auto& import : input.TlsImports) tlsImportSlots.emplace(std::tuple{import.Symbol, import.DylibOrdinal, import.Weak}, 0);');
    source=replace(source,'    for (auto& [symbol, slot] : tlsImportSlots) {','    for (auto& [key, slot] : tlsImportSlots) {\n        const auto& [symbol, ordinal, weak] = key;');
    source=replace(source,'input.Binds.push_back({symbol, metaRva + static_cast<std::uint32_t>(slot)});','input.Binds.push_back({symbol, metaRva + static_cast<std::uint32_t>(slot), 0, weak, ordinal});');
    source=replace(source,'tlsImportSlots.at(import.Symbol)','tlsImportSlots.at(std::tuple{import.Symbol, import.DylibOrdinal, import.Weak})');
    for (const [symbol,library] of [
      ['___aps5_get_pending_module_args_nid_no_patch','@rpath/libkernel.prx'],
      ['___aps5_set_module_init_result_nid_no_patch','@rpath/libkernel.prx'],
      ['_Aps5GuestTlsAllocate_nid_no_patch','@rpath/libkernel.prx'],
      ['_Aps5GuestTlsRegister_nid_no_patch','@rpath/libkernel.prx'],
      ['_Aps5StartGuest_nid_no_patch','@rpath/libkernel.prx'],
    ]) {
      const expression = new RegExp('input\\.Binds\\.push_back\\(\\{"'+symbol+'", ([^\\n]+)\\}\\);','g');
      const matches=[...source.matchAll(expression)];
      if(matches.length!==1)throw Error('AnyPS5 native helper binding changed: '+symbol);
      source=source.replace(expression,(_,target)=>'input.Binds.push_back({"'+symbol+'", '+target+', 0, false, libraryOrdinal("'+library+'")});');
    }
    source=replace(source,'input.Binds.push_back({"___cxa_atexit", metaRva + static_cast<std::uint32_t>(MetaCxaAtexitSlot)});','input.Binds.push_back({"___cxa_atexit", metaRva + static_cast<std::uint32_t>(MetaCxaAtexitSlot), 0, false, 1});');
    source=replace(source,'    for (const auto& item : input.Binds) {\n        const auto [segment, offset] = Locate(segments, item.Rva, 8);',`    std::int32_t currentOrdinal = -2;
    for (const auto& item : input.Binds) {
        if (item.DylibOrdinal < -3 || (item.DylibOrdinal > 0 && static_cast<std::size_t>(item.DylibOrdinal) > input.Dylibs.size() + 1)) throw Domain::RelinkerException("Mach-O binding has an invalid dependency ordinal", item.Rva);
        if (item.DylibOrdinal != currentOrdinal) {
            if (item.DylibOrdinal < 0) bind.push_back(BindOpcodeSetDylibSpecialImm | (static_cast<std::uint8_t>(item.DylibOrdinal) & 0x0f));
            else if (item.DylibOrdinal <= 15) bind.push_back(BindOpcodeSetDylibOrdinalImm | static_cast<std::uint8_t>(item.DylibOrdinal));
            else {
                bind.push_back(BindOpcodeSetDylibOrdinalUleb);
                AppendUleb(bind, static_cast<std::uint32_t>(item.DylibOrdinal));
            }
            currentOrdinal = item.DylibOrdinal;
        }
        const auto [segment, offset] = Locate(segments, item.Rva, 8);`);
    return source;
  });
  return changed;
}
