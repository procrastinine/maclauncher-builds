// SPDX-License-Identifier: GPL-2.0-only
namespace {

constexpr std::uint32_t APPLY_SOURCE_ANGLE = 1u << 0;
constexpr std::uint32_t APPLY_SOURCE_DOPPLER = 1u << 1;
constexpr std::uint32_t APPLY_VOLUME_MATRIX = 1u << 2;
constexpr std::uint32_t APPLY_A3D_ATTRIBUTE = 1u << 3;
constexpr std::uint32_t APPLY_A3D_AMBISONICS = 1u << 4;
constexpr std::uint32_t ROLLOFF_CLAMPED_INVERSE = 3;
constexpr std::uint32_t ROLLOFF_MODELS = 6;

struct Vec {
    float x;
    float y;
    float z;
};

Vec Of(const Ngs2GeomVector& v) {
    return {v.x, v.y, v.z};
}

float Dot(const Vec& a, const Vec& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

float Length(const Vec& v) {
    return std::sqrt(Dot(v, v));
}

Vec Scale(const Vec& v, float factor) {
    return {v.x * factor, v.y * factor, v.z * factor};
}

bool Finite(const Vec& v) {
    return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z);
}

// The listener matrix maps the scene into the listener's frame: x to its right, y up and z ahead.
Vec Rotate(const Ngs2GeomListenerWork& work, const Vec& v) {
    const auto& m = work.matrix;
    return {m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z};
}

Vec Transform(const Ngs2GeomListenerWork& work, const Vec& v) {
    const Vec rotated = Rotate(work, v);
    return {rotated.x + work.matrix[0][3], rotated.y + work.matrix[1][3], rotated.z + work.matrix[2][3]};
}

// Distance attenuation with the OpenAL distance models: the inverse, linear and exponential curves
// start at the reference distance, and the clamped ones hold their level past the maximum distance.
float Rolloff(const Ngs2GeomRolloff& rolloff, float distance) {
    const float reference = rolloff.reference_distance;
    const float maximum = rolloff.max_distance;
    const float factor = rolloff.rolloff_factor;
    float d = std::max(distance, reference);
    if (rolloff.model >= ROLLOFF_CLAMPED_INVERSE) d = std::min(d, maximum);
    switch (rolloff.model % ROLLOFF_CLAMPED_INVERSE) {
        case 0: return reference / (reference + factor * (d - reference));
        case 1: return maximum > reference ? std::clamp(1.0f - factor * (d - reference) / (maximum - reference), 0.0f, 1.0f) : 1.0f;
        default: return std::pow(d / reference, -factor);
    }
}

// The cone angles are whole apertures in degrees around the source's direction; between them the
// level moves linearly from the inner to the outer level.
float ConeLevel(const Ngs2GeomCone& cone, const Vec& direction, const Vec& toListener) {
    const float directionLength = Length(direction);
    const float listenerLength = Length(toListener);
    if (directionLength == 0.0f || listenerLength == 0.0f) return cone.inner_level;
    const float cosine = std::clamp(Dot(direction, toListener) / (directionLength * listenerLength), -1.0f, 1.0f);
    const float angle = std::acos(cosine) * 180.0f / std::numbers::pi_v<float>;
    const float inner = cone.inner_angle * 0.5f;
    const float outer = cone.outer_angle * 0.5f;
    if (angle <= inner) return cone.inner_level;
    if (angle >= outer || outer <= inner) return cone.outer_level;
    return cone.inner_level + (cone.outer_level - cone.inner_level) * (angle - inner) / (outer - inner);
}

// The OpenAL Doppler shift, with both velocities projected on the line from the source to the listener.
float DopplerRatio(const Ngs2GeomListenerWork& listener, const Ngs2GeomSourceParam& source, const Vec& position) {
    const float distance = Length(position);
    const float factor = source.doppler_factor;
    const float speed = listener.sound_speed;
    if (distance == 0.0f || factor == 0.0f) return 1.0f;
    const Vec toListener = Scale(position, -1.0f / distance);
    const float limit = std::nextafter(speed / factor, 0.0f);
    const float listenerSpeed = std::min(Dot(Rotate(listener, Of(listener.velocity)), toListener), limit);
    const float sourceSpeed = std::min(Dot(Rotate(listener, Of(source.velocity)), toListener), limit);
    return (speed - factor * listenerSpeed) / (speed - factor * sourceSpeed);
}

void ValidateSource(const Ngs2GeomSourceParam& source) {
    const auto& rolloff = source.rolloff;
    const auto& cone = source.cone;
    if (!Finite(Of(source.position)) || !Finite(Of(source.velocity)) || !Finite(Of(source.direction)) || rolloff.model >= ROLLOFF_MODELS ||
        !(rolloff.reference_distance > 0.0f) || !(rolloff.max_distance >= rolloff.reference_distance) || !(rolloff.rolloff_factor >= 0.0f) ||
        !(cone.inner_angle >= 0.0f && cone.inner_angle <= 360.0f) || !(cone.outer_angle >= 0.0f && cone.outer_angle <= 360.0f) ||
        !(source.min_level <= source.max_level) || !(source.radius >= 0.0f) || !(source.doppler_factor >= 0.0f)) {
        APS5_INVALID_ARG_EX;
    }
}

}
