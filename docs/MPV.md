# mpv decoded-frame runtime

The `mpv` project in this repository is a native host for decoded video frames, for Apple Silicon Macs with macOS 27 or later. It loads the original libmpv library and the libraries that libmpv depends on, passes decoded GPU frames and their source timestamps to MacLauncher's shared graphics presenter, and leaves audio to libmpv. The upstream command-line mpv package is a separate runtime; MacLauncher's [Video](https://github.com/procrastinine/maclauncher/blob/master/docs/game-types/VIDEO.md) page describes playback and that mpv player runtime.

## Presentation

In version `0.41.0-MCLv7`, decoded PQ/BT.2020 frames reach the presenter as RGBA16Float, and the presenter outputs linear Display P3 using the display's actual headroom. Decoder metadata and video-filter metadata each keep their own source luminance information. When playback starts paused, the first decoded image stays visible, and the video layer fits the source aspect ratio inside the window.

## Source and build

`producers/mpv-render/v7/source.json` records the original library artifact, the upstream commit, the backported changes and the exact producer inputs, and the upstream headers come from the submodule `producers/maclauncher/src/external/mpv-player`. The runtime includes the original library and its third-party notices. Building requires Node.js 24 or later and Apple's command-line tools.

```sh
git submodule update --init producers/maclauncher/src/external/mpv-player
node producers/mpv-render/v7/build.mjs --check
node producers/mpv-render/v7/build.mjs --config /absolute/path/to/media-inputs.json
node producers/mpv-render/v7/package.mjs \
  --input /absolute/path/to/prepared-media-runtime \
  --output /absolute/path/to/new-package-directory
```

The JSON file passed with `--config` has the fields `library`, `referenceExecutable`, `dependencyRoots`, `output`, `source` and `notices`. `source` identifies the original version, the commit and the SHA-256 of the library artifact. Each notice entry names the original files, their licenses and source links. The producer verifies the selected library image, builds the native host, finds every library the host actually loads and records the hash of each, without downloading any dependencies.

## Package layout

The package has an outer `manifest.json`, and the runtime files are under `files/`:

| Path | Contents |
| --- | --- |
| `files/video-runtime.json` | Decoded-frame interface and library list |
| `files/source.json` | Exact source inputs |
| `files/mpv.app/Contents/MacOS/mpv` | Executable |

Binary archives contain the runtime and its notices, and the release tag identifies the producer, the source in this repository and the upstream commit used for the package.
