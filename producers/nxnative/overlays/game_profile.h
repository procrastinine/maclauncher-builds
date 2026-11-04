#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct { const char *build, *ver, *mods; } nxnative_version;
typedef struct {
    const char *id, *directory, *name, *romfs_marker, *args, *env, *launch_param, *ue_fps_cvar, *upscaler_keys;
    const char **modules;
    size_t module_count, version_count;
    nxnative_version *versions;
    uint64_t program_id, mem_reserve, mem_alias, mem_stack, app_pool, mem_used, sys_resource, stdalloc_cap;
    int mem_map_limit, present_display, core_preempt, alloc_big_align, fps_target, fps_max, fps_hold, present_snap, pso_mtl4;
    int ue_texture_pool, enc_thread, screen_aspect, shader_key_skip_off, shader_key_skip_len, upscaler_n;
    int shared_font_present, shared_font_ttf, pad_layout, opmode, perf_boost;
    int tex_flush_upload, render_cond, tex_dirty_upload, tex_dyn_slots, gpu_ts_segment, vconv_range;
    int nvn_api_present, nvn_api_major, nvn_api_minor;
} nxnative_profile;
const nxnative_profile *nxnative_profile_current(void);

#define DM_GAME_ID (nxnative_profile_current()->id)
#define DM_GAME_NAME (nxnative_profile_current()->name)
#define DM_GAME_PROGRAM_ID (nxnative_profile_current()->program_id)
#define DM_GAME_NMOD ((int)nxnative_profile_current()->module_count)
#define DM_GAME_ROMFS_MARKER (nxnative_profile_current()->romfs_marker)
#define DM_GAME_MEM_RESERVE (nxnative_profile_current()->mem_reserve)
#define DM_GAME_MEM_ALIAS (nxnative_profile_current()->mem_alias)
#define DM_GAME_MEM_STACK (nxnative_profile_current()->mem_stack)
#define DM_GAME_APP_POOL (nxnative_profile_current()->app_pool)
#define DM_GAME_MEM_USED (nxnative_profile_current()->mem_used)
#define DM_GAME_SYS_RESOURCE (nxnative_profile_current()->sys_resource)
#define DM_GAME_ARGS (nxnative_profile_current()->args)
#define DM_GAME_ENV (nxnative_profile_current()->env)
#define DM_GAME_MEM_MAP_LIMIT (nxnative_profile_current()->mem_map_limit)
#define DM_GAME_STDALLOC_CAP (nxnative_profile_current()->stdalloc_cap)
#define DM_GAME_PRESENT_DISPLAY (nxnative_profile_current()->present_display)
#define DM_GAME_CORE_PREEMPT (nxnative_profile_current()->core_preempt)
#define DM_GAME_ALLOC_BIG_ALIGN (nxnative_profile_current()->alloc_big_align)
#define DM_GAME_FPS_TARGET (nxnative_profile_current()->fps_target)
#define DM_GAME_FPS_HOLD (nxnative_profile_current()->fps_hold)
#define DM_GAME_PRESENT_SNAP (nxnative_profile_current()->present_snap)
#define DM_GAME_PSO_MTL4 (nxnative_profile_current()->pso_mtl4)
#define DM_GAME_PAD_LAYOUT (nxnative_profile_current()->pad_layout)
#define DM_GAME_OPMODE (nxnative_profile_current()->opmode)
#define DM_GAME_PERF_BOOST (nxnative_profile_current()->perf_boost)
#define DM_GAME_TEX_FLUSH_UPLOAD (nxnative_profile_current()->tex_flush_upload)
#define DM_GAME_RENDER_COND (nxnative_profile_current()->render_cond)
#define DM_GAME_TEX_DIRTY_UPLOAD (nxnative_profile_current()->tex_dirty_upload)
#define DM_GAME_TEX_DYN_SLOTS (nxnative_profile_current()->tex_dyn_slots)
#define DM_GAME_GPU_TS_SEGMENT (nxnative_profile_current()->gpu_ts_segment)
#define DM_GAME_VCONV_RANGE (nxnative_profile_current()->vconv_range)

#define DM_GAME_LAUNCH_PARAM (nxnative_profile_current()->launch_param)
#define DM_GAME_FPS_MAX (nxnative_profile_current()->fps_max)
#define DM_GAME_UE_TEXTURE_POOL (nxnative_profile_current()->ue_texture_pool)
#define DM_GAME_UE_FPS_CVAR (nxnative_profile_current()->ue_fps_cvar)
#define DM_GAME_ENC_THREAD (nxnative_profile_current()->enc_thread)
#define DM_GAME_SCREEN_ASPECT (nxnative_profile_current()->screen_aspect)
#define DM_GAME_SHADER_KEY_SKIP_OFF (nxnative_profile_current()->shader_key_skip_off)
#define DM_GAME_SHADER_KEY_SKIP_LEN (nxnative_profile_current()->shader_key_skip_len)
#define DM_GAME_UPSCALER_KEYS (nxnative_profile_current()->upscaler_keys)
#define DM_GAME_UPSCALER_N (nxnative_profile_current()->upscaler_n)
