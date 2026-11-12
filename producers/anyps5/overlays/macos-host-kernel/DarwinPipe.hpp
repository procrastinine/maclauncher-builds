// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>

namespace AnyPS5Darwin {
inline int CreatePipe(int (&descriptors)[2], int flags) {
    if (::pipe(descriptors) != 0) return -1;
    const auto fail = [&] {
        const int error = errno;
        ::close(descriptors[0]);
        ::close(descriptors[1]);
        errno = error;
        return -1;
    };
    for (const int descriptor : descriptors) {
        if ((flags & O_CLOEXEC) != 0) {
            const int current = ::fcntl(descriptor, F_GETFD);
            if (current == -1 || ::fcntl(descriptor, F_SETFD, current | FD_CLOEXEC) == -1) return fail();
        }
        if ((flags & O_NONBLOCK) != 0) {
            const int current = ::fcntl(descriptor, F_GETFL);
            if (current == -1 || ::fcntl(descriptor, F_SETFL, current | O_NONBLOCK) == -1) return fail();
        }
    }
    return 0;
}
}
