// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_GDTOA_REENTRANT_H
#define ANYPS5_GDTOA_REENTRANT_H
#include <pthread.h>
typedef pthread_mutex_t mutex_t;
#define __isthreaded 1
#define mutex_lock pthread_mutex_lock
#define mutex_unlock pthread_mutex_unlock
#endif
