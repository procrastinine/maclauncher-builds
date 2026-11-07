// SPDX-License-Identifier: MIT
#include "protocol.h"
#include <dlfcn.h>
static uint32_t camera_call(void* args){
    MLTemporalCameraCall* call=args;
    if(!call||call->size!=sizeof(*call)||call->version!=1||call->reserved)return 0xc000000d;
    call->accepted=0;
    int(*set)(const RSTemporalCamera*)=dlsym(RTLD_DEFAULT,"rsSetTemporalCameraForNextScale");
    if(set)call->accepted=set(&call->camera)==0;
    return 0;
}
static uint32_t clear_call(void* args){
    MLTemporalCameraCall* call=args;
    if(!call||call->size!=sizeof(*call)||call->version!=1||call->reserved)return 0xc000000d;
    call->accepted=0;
    void(*clear)(void)=dlsym(RTLD_DEFAULT,"rsClearTemporalCameraForNextScale");
    if(clear)clear();
    return 0;
}
__attribute__((visibility("default"))) uint32_t(*const __wine_unix_call_funcs[])(void*)={camera_call,clear_call};
