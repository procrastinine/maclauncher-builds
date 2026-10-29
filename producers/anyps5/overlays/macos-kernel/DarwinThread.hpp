#ifndef ANYPS5_DARWIN_THREAD_HPP
#define ANYPS5_DARWIN_THREAD_HPP

#include <cstdint>
#include <mach/mach.h>
#include <pthread.h>
#include <stdexcept>

namespace DarwinThread {

inline bool CpuTime(pthread_t thread, thread_basic_info_data_t& time) {
    const auto port = ::pthread_mach_thread_np(thread);
    if (port == MACH_PORT_NULL) return false;
    mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
    const auto result = ::thread_info(port, THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&time), &count);
    if (result == KERN_INVALID_ARGUMENT || result == KERN_TERMINATED || result == MACH_SEND_INVALID_DEST) return false;
    if (result != KERN_SUCCESS) throw std::runtime_error("Cannot query guest thread CPU time");
    return true;
}

inline std::uint64_t CpuNanos(const thread_basic_info_data_t& time) {
    const auto seconds = static_cast<std::uint64_t>(time.user_time.seconds) + time.system_time.seconds;
    const auto micros = static_cast<std::uint64_t>(time.user_time.microseconds) + time.system_time.microseconds;
    return seconds * 1000000000ULL + micros * 1000ULL;
}

}

#endif
