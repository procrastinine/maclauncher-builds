#pragma once

#include <arpa/inet.h>
#include <net/if.h>
#include <net/route.h>
#include "prx/libc/include/specifics/macos/NetworkInterfaces.hpp"
#include <SystemConfiguration/SystemConfiguration.h>
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace DarwinNetwork {

struct Traffic {
    std::uint64_t sent = 0;
    std::uint64_t received = 0;
};

inline Traffic InterfaceTraffic() {
    Traffic result;
    for (const auto& row : DarwinNetworkInterfaces::Statistics()) {
        if (!(row.ifm_flags & IFF_UP) || (row.ifm_flags & IFF_LOOPBACK)) continue;
        if (row.ifm_data.ifi_obytes > std::numeric_limits<std::uint64_t>::max() - result.sent ||
            row.ifm_data.ifi_ibytes > std::numeric_limits<std::uint64_t>::max() - result.received)
            throw std::overflow_error("sceNetCtlGetIfStat: host interface byte counters overflow");
        result.sent += row.ifm_data.ifi_obytes;
        result.received += row.ifm_data.ifi_ibytes;
    }
    return result;
}

inline void AppendDnsAddresses(CFPropertyListRef properties, std::vector<in_addr>& servers) {
    if (!properties || CFGetTypeID(properties) != CFDictionaryGetTypeID()) return;
    const auto dictionary = static_cast<CFDictionaryRef>(properties);
    const auto addresses = CFDictionaryGetValue(dictionary, kSCPropNetDNSServerAddresses);
    if (!addresses || CFGetTypeID(addresses) != CFArrayGetTypeID()) return;
    const auto array = static_cast<CFArrayRef>(addresses);
    for (CFIndex index = 0; index < CFArrayGetCount(array); ++index) {
        const auto address = CFArrayGetValueAtIndex(array, index);
        if (!address || CFGetTypeID(address) != CFStringGetTypeID()) continue;
        char text[64]{};
        in_addr server{};
        if (!CFStringGetCString(static_cast<CFStringRef>(address), text, sizeof(text), kCFStringEncodingUTF8) ||
            inet_pton(AF_INET, text, &server) != 1) continue;
        if (std::none_of(servers.begin(), servers.end(), [server](const in_addr& existing) { return existing.s_addr == server.s_addr; }))
            servers.push_back(server);
    }
}

inline std::vector<in_addr> DnsServers() {
    using OwnedCF = std::unique_ptr<const void, decltype(&CFRelease)>;
    const OwnedCF store(SCDynamicStoreCreate(nullptr, CFSTR("AnyPS5 network configuration"), nullptr, nullptr), CFRelease);
    if (!store) throw std::runtime_error("sceNetCtlGetInfo: the host DNS configuration is unavailable");
    const OwnedCF dns(SCDynamicStoreCopyValue(static_cast<SCDynamicStoreRef>(store.get()), CFSTR("State:/Network/Global/DNS")), CFRelease);
    std::vector<in_addr> servers;
    AppendDnsAddresses(dns.get(), servers);
    return servers;
}

} // namespace DarwinNetwork
