import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 pooled buffer source changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyPooledBuffersOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver');
  const edit = async (relative, transform) => {
    const file = path.join(base, relative);
    await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
  };
  await edit('Graphics/include/Resources.hpp', source => {
    // A class-sized buffer spans its whole pool class, so a pooled allocation serves any size within it.
    source = replace(source, 'VkMemoryPropertyFlags properties = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);',
      'VkMemoryPropertyFlags properties = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);\n    struct ClassSized {};\n    Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, ClassSized);');
    source = replace(source, '    Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, bool headroom);',
      '    Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, bool headroom, bool classSized = false);');
    return replace(source, '    std::size_t capacity;\n    // Fully made',
      '    std::size_t capacity;\n    std::size_t bufferBytes = 0;\n    // Fully made');
  });
  await edit('Graphics/src/Resources.cpp', source => {
    source = replace(source, 'Buffer::Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties) : Buffer(context, size, usage, properties, false) {}',
      'Buffer::Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties) : Buffer(context, size, usage, properties, false) {}\n\nBuffer::Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, ClassSized) : Buffer(context, size, usage, properties, false, true) {}');
    source = replace(source, 'Buffer::Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, bool headroom) : context(context), size(size), capacity(BufferPool::Capacity(size)), usage(BufferPool::Usage(usage, properties)), properties(properties) {',
      'Buffer::Buffer(const Context& context, std::size_t size, VkBufferUsageFlags usage, VkMemoryPropertyFlags properties, bool headroom, bool classSized) : context(context), size(size), capacity(BufferPool::Capacity(size)), bufferBytes(size), usage(BufferPool::Usage(usage, properties)), properties(properties) {\n#ifndef __APPLE__\n    classSized = false;\n#endif');
    source = replace(source, '        if (allocation->bufferBytes != size) {', `        bufferBytes = allocation->bufferBytes;
        if ((!classSized && bufferBytes != size) || (classSized && bufferBytes < size)) {
            const auto wanted = classSized && capacity <= allocationBytes ? capacity : size;`);
    source = replace(source, '                buffer = BindExactBuffer(context, size, this->usage, memory, offset, allocationBytes);',
      '                buffer = BindExactBuffer(context, wanted, this->usage, memory, offset, allocationBytes);\n                bufferBytes = wanted;');
    source = replace(source, '    try {\n        VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};\n        info.size = size;\n        info.usage = this->usage;\n        info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;\n        Check(context.Function<PFN_vkCreateBuffer>("vkCreateBuffer")(context.device, &info, nullptr, &buffer), "vkCreateBuffer");',
      '    try {\n        VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};\n        bufferBytes = classSized ? capacity : size;\n        info.size = bufferBytes;\n        info.usage = this->usage;\n        info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;\n        Check(context.Function<PFN_vkCreateBuffer>("vkCreateBuffer")(context.device, &info, nullptr, &buffer), "vkCreateBuffer");');
    return replace(source, '        cache->Put({buffer, memory, mapping, deviceAddress, allocationBytes, capacity, usage, properties, offset, slab, size});',
      '        cache->Put({buffer, memory, mapping, deviceAddress, allocationBytes, capacity, usage, properties, offset, slab, bufferBytes});');
  });
  await edit('Graphics/src/ShaderResources.cpp', source => {
    source = replace(source, 'std::make_unique<Buffer>(context, size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);',
      'std::make_unique<Buffer>(context, size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, Buffer::ClassSized{});');
    return replace(source, 'std::make_shared<Buffer>(context, bytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);',
      'std::make_shared<Buffer>(context, bytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, Buffer::ClassSized{});');
  });
  // Upstream retains the draw pipeline across indirect buffers on every host.
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * pool-class Vulkan buffers:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/fedacc2cbc7e4c16013930ad757fcf01104efa4d
 * pooled draw-data consumers:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/e2d6c4749b0ab802cef7c7c7bad49b0898763f83
 * pipeline retention across indirect buffers:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/111e19dc8deccca823033cd19a18ad9511eb16bd
 */
