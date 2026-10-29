import fs from 'node:fs';
import path from 'node:path';

const driver = 'core/libs/prx/libSceAgcDriver/Execution/src/VulkanDevice.cpp';
const display = 'core/libs/prx/libSceVideoOut/src/DisplayWindow.cpp';
const header = 'core/libs/prx/libSceAgcDriver/Execution/include/VulkanLibrary.hpp';
const include = '#include "prx/libSceAgcDriver/Execution/include/VulkanLibrary.hpp"\n';

function replaceOnce(text, before, after, file) {
    if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before)) {
        throw Error('AnyPS5 Vulkan overlay does not match ' + file);
    }
    return text.replace(before, after);
}

export function adaptVulkanSources(sourceRoot) {
    let device = fs.readFileSync(path.join(sourceRoot, driver), 'utf8');
    device = include + device;
    device = replaceOnce(device, `#ifdef _WIN32
    state->library = SDL_LoadObject("vulkan-1.dll");
#else
    state->library = SDL_LoadObject("libvulkan.so.1");
#endif`, '    state->library = SDL_LoadObject(AnyPS5VulkanLibraryPath());', driver);
    const enumeration = `        std::uint32_t availableCount = 0;
        const auto enumerateExtensions = state->InstanceFunction<PFN_vkEnumerateInstanceExtensionProperties>("vkEnumerateInstanceExtensionProperties");
        check(enumerateExtensions(nullptr, &availableCount, nullptr), "vkEnumerateInstanceExtensionProperties");
        std::vector<VkExtensionProperties> available(availableCount);
        check(enumerateExtensions(nullptr, &availableCount, available.data()), "vkEnumerateInstanceExtensionProperties");
`;
    device = replaceOnce(device, enumeration, '', driver);
    device = replaceOnce(device, '    std::vector<const char*> instanceExtensions;\n',
        '    std::vector<const char*> instanceExtensions;\n' + enumeration.replace(/^    /gm, ''), driver);
    const instanceStart = device.indexOf('    std::vector<const char*> instanceExtensions;');
    const instanceEnd = device.indexOf('    check(state->InstanceFunction<PFN_vkCreateInstance>');
    device = device.slice(0, instanceStart) + device.slice(instanceStart, instanceEnd).replace(/\bavailableCount\b/g, 'availableInstanceExtensionCount').replace(/\bavailable\b/g, 'availableInstanceExtensions') + device.slice(instanceEnd);
    const extensionCounts = `        create.enabledExtensionCount = static_cast<std::uint32_t>(instanceExtensions.size());
        create.ppEnabledExtensionNames = instanceExtensions.data();
    }
    check(state->InstanceFunction<PFN_vkCreateInstance>`;
    device = replaceOnce(device, extensionCounts, `    }
    if (std::any_of(availableInstanceExtensions.begin(), availableInstanceExtensions.end(), [](const auto& item) { return std::strcmp(item.extensionName, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME) == 0; })) {
        if (std::none_of(instanceExtensions.begin(), instanceExtensions.end(), [](const char* name) { return std::strcmp(name, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME) == 0; })) instanceExtensions.push_back(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);
        create.flags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    }
    create.enabledExtensionCount = static_cast<std::uint32_t>(instanceExtensions.size());
    create.ppEnabledExtensionNames = instanceExtensions.data();
    check(state->InstanceFunction<PFN_vkCreateInstance>`, driver);
    device = replaceOnce(device, '    if (window != nullptr) deviceExtensions.assign(presentationExtensions.begin(), presentationExtensions.end());\n',
        '    if (window != nullptr) deviceExtensions.assign(presentationExtensions.begin(), presentationExtensions.end());\n    if (hasExtension("VK_KHR_portability_subset")) deviceExtensions.push_back("VK_KHR_portability_subset");\n', driver);

    let window = include + fs.readFileSync(path.join(sourceRoot, display), 'utf8');
    window = replaceOnce(window, '    AgcDriverLockVulkanLoader_nid_postfix();', `    const char* vulkanLibrary = AnyPS5VulkanLibraryPath();
    AgcDriverLockVulkanLoader_nid_postfix();
    if (SDL_Vulkan_LoadLibrary(vulkanLibrary) != 0) {
        const std::string error = SDL_GetError();
        AgcDriverUnlockVulkanLoader_nid_postfix();
        throw std::runtime_error("Vulkan loader: " + error);
    }
`, display);
    window = replaceOnce(window, '    AgcDriverUnlockVulkanLoader_nid_postfix();\n    require(window != nullptr, SDL_GetError());',
        '    SDL_Vulkan_UnloadLibrary();\n    AgcDriverUnlockVulkanLoader_nid_postfix();\n    require(window != nullptr, SDL_GetError());', display);
    return {
        [driver]: device,
        [display]: window,
        [header]: fs.readFileSync(new URL('./VulkanLibrary.hpp', import.meta.url), 'utf8'),
    };
}

export function applyVulkanOverlay(projectionRoot) {
    const sources = adaptVulkanSources(projectionRoot);
    for (const [relative, content] of Object.entries(sources)) {
        const file = path.join(projectionRoot, relative);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, content);
    }
    return Object.keys(sources);
}
