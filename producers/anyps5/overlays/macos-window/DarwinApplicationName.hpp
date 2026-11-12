#pragma once
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <string>
namespace DarwinApplicationName {
inline const std::string& BundleTitle() {
    static const std::string title = [] {
        const auto bundle = CFBundleGetMainBundle();
        if (!bundle) return std::string{};
        auto value = CFBundleGetValueForInfoDictionaryKey(bundle, CFSTR("CFBundleDisplayName"));
        if (!value) value = CFBundleGetValueForInfoDictionaryKey(bundle, kCFBundleNameKey);
        if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return std::string{};
        const auto string = static_cast<CFStringRef>(value);
        const auto bytes = CFStringGetMaximumSizeForEncoding(CFStringGetLength(string), kCFStringEncodingUTF8) + 1;
        std::string result(static_cast<std::size_t>(bytes), '\0');
        if (!CFStringGetCString(string, result.data(), bytes, kCFStringEncodingUTF8)) return std::string{};
        result.resize(std::char_traits<char>::length(result.c_str()));
        return result;
    }();
    return title;
}
}
#endif
