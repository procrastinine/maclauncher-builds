// SPDX-License-Identifier: GPL-2.0-only
// x86-64 System V guest code for the per-signature thunk proof. build-proof.mjs compiles it for x86-64 and the host runs
// it under FEXCore; each call goes through a slot that holds a thunk stub, as a PS5 module's import slots do.
typedef struct { long long a, b, c, d; } Big;          // 32 bytes: returned through a hidden pointer
typedef struct { long long tag; double value; } Pair; // INTEGER and SSE eightbytes: returned in rax and xmm0

struct Slots {
  Big (*make_big)(long long, long long, long long, long long, long long, long long, long long, long long, long long, long long);
  long double (*scale)(long double, int);
  double (*weigh)(double, double, double, double, double, double, double, double, double, double);
  Pair (*pair)(long long, double);
};
struct Inputs { long long i[10]; double d[10]; long double x; int n; long long tag; double value; };
struct Results { Big big; long double scaled; double weighed; Pair pair; };

void guest_abi(const struct Slots* s, const struct Inputs* in, struct Results* out) {
  out->big = s->make_big(in->i[0], in->i[1], in->i[2], in->i[3], in->i[4], in->i[5], in->i[6], in->i[7], in->i[8], in->i[9]);
  out->scaled = s->scale(in->x, in->n);
  out->weighed = s->weigh(in->d[0], in->d[1], in->d[2], in->d[3], in->d[4], in->d[5], in->d[6], in->d[7], in->d[8], in->d[9]);
  out->pair = s->pair(in->tag, in->value);
}
