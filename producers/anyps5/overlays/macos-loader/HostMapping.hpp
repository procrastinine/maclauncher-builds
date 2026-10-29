// SPDX-License-Identifier: GPL-2.0-only
#ifndef ANYPS5_HOST_MAPPING_HPP
#define ANYPS5_HOST_MAPPING_HPP
#ifdef __APPLE__
#include "macos/HostMapping.hpp"
#else
#include "linux/HostMapping.hpp"
#endif
#endif
