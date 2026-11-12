// SPDX-License-Identifier: GPL-2.0-only
#ifndef AGCDRIVER_EXECUTION_DRIVER_QUEUES_QUEUESTALLWATCH_HPP
#define AGCDRIVER_EXECUTION_DRIVER_QUEUES_QUEUESTALLWATCH_HPP

#include <chrono>
#include <condition_variable>
#include <cstdint>

namespace AgcDriver::DriverDetail {

// Queue 0's idle worker waits at most this long while recorded batches exist: a completion counted
// off the worker (a CPU write-back over a GPU-stored label, a deferred action appended by another
// queue) wakes it without the driver mutex, and that wake can arrive between its predicate check
// and its wait.
inline constexpr std::chrono::milliseconds QueueZeroIdleBound{2};

inline bool QueueZeroIdleBounded(std::uint32_t queue, bool enabled, bool deviceExists, std::uint64_t liveBatches) {
    return queue == 0 && enabled && deviceExists && liveBatches != 0;
}

template <class Lock, class Predicate>
void QueueIdleWait(std::condition_variable& changed, Lock& lock, bool bounded, Predicate woken) {
    if (bounded) changed.wait_for(lock, QueueZeroIdleBound, woken);
    else changed.wait(lock, woken);
}

// When the queue-0 stall report prints: once per stall, after queue 0 has neither taken a submission
// nor moved to another packet for the threshold while work that may need it is pending, and again
// only after queue 0 moves. A threshold of zero or less never reports.
class QueueStallWatch {
public:
    using Clock = std::chrono::steady_clock;

    QueueStallWatch(std::chrono::milliseconds threshold, std::uint64_t submissions, std::uint64_t packet, Clock::time_point now)
        : threshold(threshold), submissions(submissions), packet(packet), since(now) {}

    // Returns true when the report prints for this observation.
    bool Observe(std::uint64_t currentSubmissions, std::uint64_t currentPacket, bool pending, Clock::time_point now) {
        moved = currentSubmissions != submissions || currentPacket != packet;
        if (moved) {
            submissions = currentSubmissions;
            packet = currentPacket;
            since = now;
            reported = false;
            return false;
        }
        if (reported || !pending || threshold.count() <= 0 || now - since < threshold) return false;
        reported = true;
        return true;
    }

    bool Moved() const { return moved; }
    double StalledSeconds(Clock::time_point now) const { return std::chrono::duration<double>(now - since).count(); }

private:
    std::chrono::milliseconds threshold;
    std::uint64_t submissions;
    std::uint64_t packet;
    Clock::time_point since;
    bool reported = false;
    bool moved = false;
};

}

#endif
