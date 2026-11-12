// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
import {edit} from '../macos-aborts/apply.mjs';
export function applyAddonsOverlay(root) {
  const header = 'core/libs/prx/libSceAppContent/include/DiskAddons.hpp';
  fs.copyFileSync(path.join(import.meta.dirname, 'DiskAddons.hpp'), path.join(root, header));
  edit(root, 'core/libs/prx/libSceAppContent/Export.cpp', [
    ['#include <algorithm>', '#include <algorithm>\n#ifdef __APPLE__\n#include "prx/libSceAppContent/include/DiskAddons.hpp"\n#endif'],
    ['        return list;\n    }();', `#ifdef __APPLE__
        for (const auto& addon : DiskAddons::InstalledAddons()) {
            auto found = std::find_if(list.begin(), list.end(), [&](const AddonEntry& entry) {
                return std::string_view(entry.info.entitlement_label.data) == addon.label;
            });
            if (found == list.end()) {
                AddonEntry entry{};
                std::memcpy(entry.info.entitlement_label.data, addon.label.data(), addon.label.size());
                entry.info.status = addon.status();
                entry.mount_point = "/addcont" + std::to_string(list.size());
                list.push_back(std::move(entry));
                found = std::prev(list.end());
            }
            if (!found->has_host_path && addon.hasData) {
                found->host_path = addon.folder;
                found->has_host_path = true;
                BlockPathAlias_nid_no_patch(found->mount_point.c_str());
            }
        }
#endif
        return list;
    }();`]
  ]);
  return [header, 'core/libs/prx/libSceAppContent/Export.cpp'];
}
