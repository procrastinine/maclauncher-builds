// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from SteveTanSaMa's DXMT ownership fix, origin
// 8b3a6d08ccdf3ad343739b0833918899df7a3a8f, as carried by fxgl/steamac
// 32a66354a24cc62d4c9ec1d263c5df7a0b1e1d7e, host/dxmt/patches/0011.
import fs from 'node:fs';
import path from 'node:path';

export function applyReferenceOwnershipOverlay(root) {
  const file = path.join(root, 'src/winemetal/Metal.hpp');
  let source = fs.readFileSync(file, 'utf8');
  const edits = [
    ['Reference(Reference &&move) {', 'Reference(Reference &&move) noexcept {'],
    [`operator=(const Reference &copy) {
    if (this->handle != NULL_OBJECT_HANDLE)
      this->release();
    this->handle = copy.handle;
    this->retain();
    return *this;
  }`, `operator=(const Reference &copy) {
    return operator=(static_cast<Class>(copy));
  }`],
    [`operator=(Class non_retained) {
    if (this->handle != NULL_OBJECT_HANDLE)
      this->release();
    this->handle = non_retained.handle;
    this->retain();`, `operator=(Class non_retained) {
    // The borrowed input may alias our last owning reference.
    non_retained.retain();
    if (this->handle != NULL_OBJECT_HANDLE)
      this->release();
    this->handle = non_retained.handle;`],
    ['operator=(Reference &&move) {', `operator=(Reference &&move) noexcept {
    if (this == &move)
      return *this;`],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw new Error('DXMT reference ownership source changed: src/winemetal/Metal.hpp');
    source = source.replace(before, after);
  }
  fs.writeFileSync(file, source);
}
