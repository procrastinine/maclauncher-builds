#pragma once

#include <net/if.h>
#include <net/route.h>
#include <sys/sysctl.h>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace DarwinNetworkInterfaces {

inline std::vector<if_msghdr2> ParseStatistics(const void* bytes, std::size_t size) {
    struct Prefix {
        std::uint16_t length;
        std::uint8_t version;
        std::uint8_t type;
    };
    std::vector<if_msghdr2> rows;
    const auto* table = static_cast<const unsigned char*>(bytes);
    for (std::size_t offset = 0; offset < size;) {
        Prefix prefix{};
        if (size - offset < sizeof(prefix)) throw std::runtime_error("Darwin network: truncated host interface record");
        std::memcpy(&prefix, table + offset, sizeof(prefix));
        if (prefix.length < sizeof(prefix) || prefix.length > size - offset)
            throw std::runtime_error("Darwin network: invalid host interface record length");
        if (prefix.version == RTM_VERSION && prefix.type == RTM_IFINFO2) {
            if (prefix.length < sizeof(if_msghdr2)) throw std::runtime_error("Darwin network: truncated host interface statistics");
            if_msghdr2 row{};
            std::memcpy(&row, table + offset, sizeof(row));
            rows.push_back(row);
        }
        offset += prefix.length;
    }
    return rows;
}

inline std::vector<if_msghdr2> Statistics() {
    int name[] = {CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0};
    // Interface additions can grow the table between the size and data queries.
    for (unsigned attempt = 0; attempt < 4; ++attempt) {
        std::size_t size = 0;
        if (sysctl(name, 6, nullptr, &size, nullptr, 0) != 0)
            throw std::system_error(errno, std::generic_category(), "Darwin network: reading host interface table size");
        if (size > 16 * 1024 * 1024) throw std::runtime_error("Darwin network: host interface table is too large");
        if (size == 0) return {};
        std::vector<unsigned char> table(size);
        if (sysctl(name, 6, table.data(), &size, nullptr, 0) == 0) return ParseStatistics(table.data(), size);
        if (errno != ENOMEM) throw std::system_error(errno, std::generic_category(), "Darwin network: reading host interface table");
    }
    throw std::runtime_error("Darwin network: host interface table changed repeatedly");
}

} // namespace DarwinNetworkInterfaces
