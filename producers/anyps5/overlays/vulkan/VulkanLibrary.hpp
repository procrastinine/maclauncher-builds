#pragma once

#include <cstdlib>
#include <stdexcept>

inline const char* AnyPS5VulkanLibraryPath() {
    const char* selected = std::getenv("ANYPS5_VULKAN_LIBRARY");
    if (selected != nullptr && *selected != '\0') return selected;
#ifdef _WIN32
    return "vulkan-1.dll";
#elif defined(__APPLE__)
    throw std::runtime_error("Vulkan loader: ANYPS5_VULKAN_LIBRARY must name the selected macOS Vulkan library");
#else
    return "libvulkan.so.1";
#endif
}
