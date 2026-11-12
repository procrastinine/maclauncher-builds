// SPDX-License-Identifier: GPL-2.0-only
#ifndef CORE_LIBS_PRX_LIBSCEAGCDRIVER_EXECUTION_INCLUDE_DRIVER_QUEUES_FLIPOVERLAP_HPP
#define CORE_LIBS_PRX_LIBSCEAGCDRIVER_EXECUTION_INCLUDE_DRIVER_QUEUES_FLIPOVERLAP_HPP

#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <mutex>

namespace AgcDriver::DriverDetail {

// A command-buffer flip submission may be accepted while the previous flip submission's recorded GPU
// work is still running. The submitter that holds the overlap still waits for and reaps that work
// before its Submit returns, so a title that reads a label after its next flip sees the completed
// value. APS5_NO_FLIP_OVERLAP=1 restores the wait before acceptance.
inline bool FlipOverlapEnabled() {
    static const bool enabled = std::getenv("APS5_NO_FLIP_OVERLAP") == nullptr;
    return enabled;
}

// Recorded work of a finished flip submission, bound to the device whose recorder issued the serial.
template <class Device>
struct FlipWork {
    std::shared_ptr<Device> device;
    std::uint64_t serial = 0;
    std::uint64_t submission = 0;
};

// At most one submitter across all threads holds the overlap, from its admission through its
// enqueue and the deferred wait. Members are used with the driver mutex held.
class FlipOverlapGate {
public:
    // Waits until the overlap is free or `escape` holds. Returns true when the caller now holds the
    // overlap, false when `escape` released the caller while another submitter holds it.
    template <class Escape>
    bool Admit(std::unique_lock<std::mutex>& lock, std::condition_variable& changed, Escape&& escape) {
        changed.wait(lock, [&] { return !held || escape(); });
        if (escape()) return false;
        held = true;
        return true;
    }
    void Leave() { held = false; }
    bool Held() const { return held; }

private:
    bool held = false;
};

// One submitter's hold on the overlap and the wait it owes after its enqueue.
template <class Device>
struct FlipOverlapClaim {
    bool owner = false;
    bool deferred = false;
    FlipWork<Device> work;

    // Runs `waitAndReap(work)` when a wait is owed, then `leave(work.device)` on every exit path.
    // `leave` drops the device reference under the GPU mutex and frees the gate.
    template <class WaitAndReap, class Leave>
    void Finish(WaitAndReap&& waitAndReap, Leave&& leave) {
        if (!owner) return;
        struct Exit {
            FlipOverlapClaim& claim;
            Leave& leave;
            ~Exit() {
                claim.owner = false;
                claim.deferred = false;
                claim.work.serial = 0;
                leave(claim.work.device);
            }
        } exit{*this, leave};
        if (deferred) waitAndReap(work);
    }
};

}

#endif
