// SPDX-License-Identifier: GPL-2.0-only
std::vector<std::uint8_t> GuestDarwinInterfaceData(const if_msghdr2& row, std::uint8_t type, std::uint8_t hardwareLength) {
    const auto& stats = row.ifm_data;
    std::vector<std::uint8_t> data(guestInterfaceDataSize, 0);
    data[0] = type;
    data[1] = stats.ifi_physical;
    data[2] = hardwareLength;
    data[3] = stats.ifi_hdrlen;
    data[4] = (row.ifm_flags & IFF_UP) && (row.ifm_flags & IFF_RUNNING) ? guestLinkStateUp : guestLinkStateDown;
    Store(data, 6, static_cast<std::uint16_t>(guestInterfaceDataSize));
    Store(data, 8, stats.ifi_mtu);
    Store(data, 12, stats.ifi_metric);
    Store(data, 16, stats.ifi_baudrate);
    const std::pair<std::uint64_t, std::size_t> counters[] = {
        {stats.ifi_ipackets, 24}, {stats.ifi_ierrors, 32}, {stats.ifi_opackets, 40}, {stats.ifi_oerrors, 48},
        {stats.ifi_collisions, 56}, {stats.ifi_ibytes, 64}, {stats.ifi_obytes, 72}, {stats.ifi_imcasts, 80},
        {stats.ifi_omcasts, 88}, {stats.ifi_iqdrops, 96}, {static_cast<std::uint64_t>(std::max(row.ifm_snd_drops, 0)), 104},
        {stats.ifi_noproto, 112},
    };
    for (const auto& [value, offset] : counters) Store(data, offset, value);
    Store(data, 120, stats.ifi_recvtiming);
    Store(data, 124, stats.ifi_xmittiming);
    Store(data, 128, static_cast<std::int64_t>(stats.ifi_lastchange.tv_sec));
    Store(data, 136, static_cast<std::int64_t>(stats.ifi_lastchange.tv_usec));
    return data;
}
