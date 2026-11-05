// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import path from 'node:path';
import {edit} from '../macos-aborts/apply.mjs';
export function applyAddonsOverlay(root) {
  const header = 'core/libs/prx/libSceAppContent/include/DiskAddons.hpp';
  fs.copyFileSync(path.join(import.meta.dirname, 'DiskAddons.hpp'), path.join(root, header));
  edit(root, `core/libs/prx/libSceAppContent/Export.cpp`, [
    [`#include <algorithm>`, `#include <algorithm>
#ifdef __APPLE__
#include "prx/libSceAppContent/include/DiskAddons.hpp"
#endif`],
    [`static void ClearDirectory(`, `#ifdef __APPLE__
namespace {
// The add-ons on the disk that the title has mounted, by mount point index (/addcont0, ...).
struct AddcontMounts {
    std::mutex mutex;
    std::vector<const DiskAddons::Addon*> slots;
};

AddcontMounts& Mounts() {
    static AddcontMounts mounts;
    return mounts;
}

std::string AddcontMountPoint(std::size_t index) {
    return "/addcont" + std::to_string(index);
}

void FillAddcontInfo(const DiskAddons::Addon& addon, AppContentAddcontInfo& info) {
    std::memset(&info, 0, sizeof(info));
    std::memcpy(info.entitlement_label.data, addon.label.data(), std::min(addon.label.size(), sizeof(info.entitlement_label.data) - 1));
    info.status = addon.status();
}

}
#endif

static void ClearDirectory(`],
    [`int APS5_VABI sceAppContentAddcontMount(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
 (void)service_label;
 if (!entitlement_label || !mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
 return SCE_APP_CONTENT_ERROR_NOT_FOUND;
}`, `#ifdef __APPLE__
int APS5_VABI sceAppContentAddcontMount(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
 (void)service_label;
 if (!entitlement_label || !mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
    const auto* addon = DiskAddons::Find(entitlement_label->data);
    if (addon == nullptr || !addon->hasData) return SCE_APP_CONTENT_ERROR_NOT_FOUND;
    auto& mounts = Mounts();
    std::lock_guard lock(mounts.mutex);
    auto slot = std::find(mounts.slots.begin(), mounts.slots.end(), addon);
    if (slot == mounts.slots.end()) {
        slot = std::find(mounts.slots.begin(), mounts.slots.end(), nullptr);
        if (slot == mounts.slots.end()) slot = mounts.slots.insert(mounts.slots.end(), nullptr);
        *slot = addon;
        AddPathAlias_nid_no_patch(AddcontMountPoint(static_cast<std::size_t>(slot - mounts.slots.begin())).c_str(), addon->folder.string().c_str());
    }
    const auto point = AddcontMountPoint(static_cast<std::size_t>(slot - mounts.slots.begin()));
    std::memset(mount_point->data, 0, sizeof(mount_point->data));
    std::memcpy(mount_point->data, point.c_str(), std::min(point.size(), sizeof(mount_point->data) - 1));
    return 0;
}
#else
int APS5_VABI sceAppContentAddcontMount(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
 (void)service_label;
 if (!entitlement_label || !mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
 return SCE_APP_CONTENT_ERROR_NOT_FOUND;
}
#endif`],
    [`int APS5_VABI sceAppContentAddcontUnmount(const AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
 if (!mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
 return SCE_APP_CONTENT_ERROR_NOT_FOUND;
}`, `#ifdef __APPLE__
int APS5_VABI sceAppContentAddcontUnmount(const AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    if (!mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
    auto& mounts = Mounts();
    std::lock_guard lock(mounts.mutex);
    for (std::size_t index = 0; index < mounts.slots.size(); ++index) {
        const auto point = AddcontMountPoint(index);
        if (mounts.slots[index] == nullptr || std::strncmp(mount_point->data, point.c_str(), sizeof(mount_point->data)) != 0) continue;
        BlockPathAlias_nid_no_patch(point.c_str());
        mounts.slots[index] = nullptr;
        return 0;
    }
    return SCE_APP_CONTENT_ERROR_NOT_FOUND;
}
#else
int APS5_VABI sceAppContentAddcontUnmount(const AppContentMountPoint* mount_point) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
 if (!mount_point) return SCE_APP_CONTENT_ERROR_PARAMETER;
 return SCE_APP_CONTENT_ERROR_NOT_FOUND;
}
#endif`],
    [`int APS5_VABI sceAppContentGetAddcontInfo(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentAddcontInfo* info) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)service_label;
    if (!entitlement_label || !info) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
    return SCE_APP_CONTENT_ERROR_DRM_NO_ENTITLEMENT;
}`, `#ifdef __APPLE__
int APS5_VABI sceAppContentGetAddcontInfo(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentAddcontInfo* info) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)service_label;
    if (!entitlement_label || !info) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
    const auto* addon = DiskAddons::Find(entitlement_label->data);
    if (addon == nullptr) return SCE_APP_CONTENT_ERROR_DRM_NO_ENTITLEMENT;
    FillAddcontInfo(*addon, *info);
    return 0;
}
#else
int APS5_VABI sceAppContentGetAddcontInfo(uint32_t service_label, const NpUnifiedEntitlementLabel* entitlement_label, AppContentAddcontInfo* info) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)service_label;
    if (!entitlement_label || !info) return SCE_APP_CONTENT_ERROR_PARAMETER;
    if (!validEntitlementLabel(*entitlement_label, 0x01500000)) return SCE_APP_CONTENT_ERROR_PARAMETER;
    return SCE_APP_CONTENT_ERROR_DRM_NO_ENTITLEMENT;
}
#endif`],
    [`int APS5_VABI sceAppContentGetAddcontInfoList(uint32_t serviceLabel, AppContentAddcontInfo* list, uint32_t listNum, uint32_t* hitNum) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)serviceLabel;
    if (!hitNum) return SCE_APP_CONTENT_ERROR_PARAMETER;
    *hitNum = 0;
    return 0;
}`, `#ifdef __APPLE__
int APS5_VABI sceAppContentGetAddcontInfoList(uint32_t serviceLabel, AppContentAddcontInfo* list, uint32_t listNum, uint32_t* hitNum) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)serviceLabel;
    if (!hitNum) return SCE_APP_CONTENT_ERROR_PARAMETER;
    const auto& addons = DiskAddons::InstalledAddons();
    // Without room for entries the call counts them; with room it fills what fits.
    if (list == nullptr || listNum == 0) {
        *hitNum = static_cast<uint32_t>(addons.size());
        return 0;
    }
    const auto count = std::min<std::size_t>(listNum, addons.size());
    for (std::size_t index = 0; index < count; ++index) FillAddcontInfo(addons[index], list[index]);
    *hitNum = static_cast<uint32_t>(count);
    return 0;
}
#else
int APS5_VABI sceAppContentGetAddcontInfoList(uint32_t serviceLabel, AppContentAddcontInfo* list, uint32_t listNum, uint32_t* hitNum) {
    if (!initialized.load()) return SCE_APP_CONTENT_ERROR_NOT_INITIALIZED;
    (void)serviceLabel;
    if (!hitNum) return SCE_APP_CONTENT_ERROR_PARAMETER;
    *hitNum = 0;
    return 0;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libSceNpEntitlementAccess/Export.cpp`, [
    [`#include <algorithm>`, `#include <algorithm>
#ifdef __APPLE__
#include "prx/libSceAppContent/include/DiskAddons.hpp"
#endif`],
    [`const std::vector<NpEntitlementAccessAddcontEntitlementInfo>& OwnedAddons() {
    static const auto owned = [] {
        std::vector<NpEntitlementAccessAddcontEntitlementInfo> addons;
        const auto path = EntitlementsPath();
        std::ifstream file(path);
        if (!file) {
            if (ConfiguredEntitlements() != nullptr || std::filesystem::exists(path)) throw std::runtime_error("NpEntitlementAccess: cannot read " + path.string());
            return addons;
        }
        std::string line;
        while (std::getline(file, line)) {
            line.erase(std::min(line.find_first_of("#;"), line.size()));
            const auto first = line.find_first_not_of(" \\t\\r");
            if (first == std::string::npos) continue;
            const auto label = line.substr(first, line.find_last_not_of(" \\t\\r") + 1 - first);
            NpEntitlementAccessAddcontEntitlementInfo info{};
            if (label.size() >= sizeof(info.entitlement_label.data)) throw std::runtime_error("NpEntitlementAccess: entitlement label '" + label + "' in " + path.string() + " is longer than 16 characters");
            std::memcpy(info.entitlement_label.data, label.data(), label.size());
            info.package_type = 3;
            info.download_status = 4;
            addons.push_back(info);
        }
        return addons;
    }();
    return owned;
}`, `#ifdef __APPLE__
const std::vector<NpEntitlementAccessAddcontEntitlementInfo>& OwnedAddons() {
    static const auto owned = [] {
        std::vector<NpEntitlementAccessAddcontEntitlementInfo> addons;
        const auto path = EntitlementsPath();
        std::ifstream file(path);
        if (!file) {
            if (ConfiguredEntitlements() != nullptr || std::filesystem::exists(path)) throw std::runtime_error("NpEntitlementAccess: cannot read " + path.string());
        }
        std::string line;
        while (std::getline(file, line)) {
            line.erase(std::min(line.find_first_of("#;"), line.size()));
            const auto first = line.find_first_not_of(" \\t\\r");
            if (first == std::string::npos) continue;
            const auto label = line.substr(first, line.find_last_not_of(" \\t\\r") + 1 - first);
            NpEntitlementAccessAddcontEntitlementInfo info{};
            if (label.size() >= sizeof(info.entitlement_label.data)) throw std::runtime_error("NpEntitlementAccess: entitlement label '" + label + "' in " + path.string() + " is longer than 16 characters");
            std::memcpy(info.entitlement_label.data, label.data(), label.size());
            info.package_type = 3;
            info.download_status = 4;
            addons.push_back(info);
        }
        // The add-ons dumped beside the game (ANYPS5_ADDCONT_DIRS) that the list above does not name.
        for (const auto& addon : DiskAddons::InstalledAddons()) {
            const bool listed = std::any_of(addons.begin(), addons.end(), [&](const auto& owned) { return addon.label == owned.entitlement_label.data; });
            if (listed) continue;
            NpEntitlementAccessAddcontEntitlementInfo info{};
            std::memcpy(info.entitlement_label.data, addon.label.data(), addon.label.size());
            info.package_type = 3;
            info.download_status = addon.status();
            addons.push_back(info);
        }
        return addons;
    }();
    return owned;
}
#else
const std::vector<NpEntitlementAccessAddcontEntitlementInfo>& OwnedAddons() {
    static const auto owned = [] {
        std::vector<NpEntitlementAccessAddcontEntitlementInfo> addons;
        const auto path = EntitlementsPath();
        std::ifstream file(path);
        if (!file) {
            if (ConfiguredEntitlements() != nullptr || std::filesystem::exists(path)) throw std::runtime_error("NpEntitlementAccess: cannot read " + path.string());
            return addons;
        }
        std::string line;
        while (std::getline(file, line)) {
            line.erase(std::min(line.find_first_of("#;"), line.size()));
            const auto first = line.find_first_not_of(" \\t\\r");
            if (first == std::string::npos) continue;
            const auto label = line.substr(first, line.find_last_not_of(" \\t\\r") + 1 - first);
            NpEntitlementAccessAddcontEntitlementInfo info{};
            if (label.size() >= sizeof(info.entitlement_label.data)) throw std::runtime_error("NpEntitlementAccess: entitlement label '" + label + "' in " + path.string() + " is longer than 16 characters");
            std::memcpy(info.entitlement_label.data, label.data(), label.size());
            info.package_type = 3;
            info.download_status = 4;
            addons.push_back(info);
        }
        return addons;
    }();
    return owned;
}
#endif`]
  ]);
  edit(root, `core/libs/prx/libc/src/General.cpp`, [
    [`#include <atomic>`, `#include <atomic>
#ifdef __APPLE__
#include <cstdlib>
#endif`],
    [`std::filesystem::path HostPath(`, `#ifdef __APPLE__
const std::optional<std::filesystem::path>& UpdateFolder() {
    static const auto folder = []() -> std::optional<std::filesystem::path> {
#ifdef _WIN32
        const wchar_t* value = _wgetenv(L"ANYPS5_UPDATE_DIR");
#else
        const char* value = std::getenv("ANYPS5_UPDATE_DIR");
#endif
        if (value == nullptr || value[0] == 0) return std::nullopt;
        const std::filesystem::path path(value);
        std::error_code error;
        if (!std::filesystem::is_directory(path, error)) return std::nullopt;
        return path;
    }();
    return folder;
}
bool ModuleName(std::string_view name) {
    const auto dot = name.rfind('.');
    if (dot == std::string_view::npos) return false;
    const auto extension = name.substr(dot);
    return SameName(extension, ".prx") || SameName(extension, ".sprx");
}
// Relinked modules retain their app0 paths. Existing directories retain their base paths.
std::optional<std::filesystem::path> UpdatedPath(const std::vector<std::string>& names, bool module, const std::filesystem::path& base) {
    if (names.size() < 2 || !SameName(names[0], "app0") || (names.size() == 2 && names[1].empty())) return std::nullopt;
    if (module && (ModuleName(names.back()) || ModuleName(base.filename().string()))) return std::nullopt;
    const auto& update = UpdateFolder();
    if (!update) return std::nullopt;
    const auto updated = ResolveHostPath(*update, std::vector<std::string>(names.begin() + 1, names.end())).make_preferred();
    std::error_code error;
    const auto status = std::filesystem::status(updated, error);
    if (!std::filesystem::exists(status)) return std::nullopt;
    if (std::filesystem::is_directory(status) && std::filesystem::exists(base, error)) return std::nullopt;
    return updated;
}
#endif

std::filesystem::path HostPath(`],
    [`    return ResolveHostPath(state.root, names, module).make_preferred();`, `#ifdef __APPLE__
    auto base = ResolveHostPath(state.root, names, module).make_preferred();
    if (auto updated = UpdatedPath(names, module, base)) return *updated;
    return base;
#else
    return ResolveHostPath(state.root, names, module).make_preferred();
#endif`]
  ]);
  return [header, ...["core/libs/prx/libSceAppContent/Export.cpp","core/libs/prx/libSceNpEntitlementAccess/Export.cpp","core/libs/prx/libc/src/General.cpp"]];
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * inserted add-on, entitlement, mount and update handling:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/56337393fc044d82b17b4ecb029da8a438372838
 */
