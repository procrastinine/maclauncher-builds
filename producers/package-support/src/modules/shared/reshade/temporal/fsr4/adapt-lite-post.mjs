// Copyright (c) MacLauncher contributors. MIT license.
/** Match the emitter's actual base graph, including the 8K Lite Lossy tier. */
export function adaptLiteTiledPost(source) {
  const before='if(!s->preparedColor || lossy || side<8 || side>40)',
        after='if(!s->preparedColor || s->retrainedWeights || s->liteCacheBytesPerPixel || side<8 || side>40)';
  if(source.split(after).length===2 && !source.includes(before))return source;
  if(source.split(before).length!==2 || source.includes(after))throw Error('FSR4 tiled POST loader adaptation changed.');
  return source.replace(before,after);
}
