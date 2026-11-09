# mpv decoded-frame runtime

The `mpv` project in this repository is a native host for decoded video frames, for Apple Silicon Macs with macOS 27 or later. It loads the original libmpv library and the libraries that libmpv depends on, passes decoded GPU frames and their source timestamps to MacLauncher's shared graphics presenter, and leaves audio to libmpv. The upstream command-line mpv package is a separate runtime; MacLauncher's [Video](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VIDEO.md) page describes playback and that mpv player runtime.

## Presentation

In version `0.41.0-MCLv7`, decoded PQ/BT.2020 frames reach the presenter as RGBA16Float, and the presenter outputs linear Display P3 using the display's actual headroom. Decoder metadata and video-filter metadata each keep their own source luminance information. When playback starts paused, the first decoded image stays visible, and the video layer fits the source aspect ratio inside the window.

## Source and build

`tools/build-mpv.mjs` builds the package. `producers/mpv-render/v7/scripts/build-mpv-library.cjs` builds libmpv from the submodule `producers/package-support/src/external/mpv-player` at its pinned commit, with the backported changes listed in `producers/mpv-render/v7/source.json` and the two patches in `producers/mpv-render/v7/native`. The host is compiled from the sources in the same directory against the shared presenter interface headers, read from the pinned MacLauncher source because the host presents through the shared graphics presenter. Building requires Node.js 24 or later, Apple's command-line tools and the build tools named in the project record.

## Package layout

The package has an outer `manifest.json`, and the runtime files are under `files/`:

| Path | Contents |
| --- | --- |
| `files/video-runtime.json` | Decoded-frame interface and library list |
| `files/mpv.app/Contents/MacOS/mpv` | Executable |

Binary archives contain the runtime and its notices, and the release tag identifies the producer, the source in this repository and the upstream commit used for the package.
