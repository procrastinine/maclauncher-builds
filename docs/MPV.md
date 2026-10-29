# mpv decoded-frame runtime

The `mpv` project supplies a native decoded-frame host for Apple Silicon with
macOS 27 or later. The host uses the original libmpv library and its portable
library closure. Decoded GPU frames and source timestamps enter MacLauncher's
shared presenter; audio remains owned by libmpv. The upstream command-line
mpv package remains a separate runtime profile. Version `0.41.0-MCLv7` carries
PQ/BT.2020 decoded frames in RGBA16Float into the shared color presenter,
with linear Display P3 output and actual display headroom. Decoder and video-filter
metadata retain their separate source luminance information. Paused startup retains the first decoded image, and the video layer fits the source aspect ratio within the window.

`producers/mpv-render/v7/source.json` records the original library artifact,
upstream source revision, backports and exact producer inputs. The upstream
headers are pinned at
`producers/maclauncher/src/external/mpv-player`. The original library and
third-party notices are retained in the runtime. Builds use Node.js 24 or
later and Apple's command-line tools.

```sh
git submodule update --init producers/maclauncher/src/external/mpv-player
node producers/mpv-render/v7/build.mjs --check
node producers/mpv-render/v7/build.mjs --config /absolute/path/to/media-inputs.json
node producers/mpv-render/v7/package.mjs \
  --input /absolute/path/to/prepared-media-runtime \
  --output /absolute/path/to/new-package-directory
```

The media input JSON specifies `library`, `referenceExecutable`,
`dependencyRoots`, `output`, `source` and `notices`. `source` identifies the
original version, commit and library artifact SHA-256. Notice entries name
the original files, licenses and source links. The producer verifies the
selected library image, builds the native host, resolves its actual library
closure and records each image hash. It does not download dependencies.

The package contains an outer `manifest.json` and the runtime files beneath
`files/`. `files/video-runtime.json` describes the decoded-frame contract and
library images; `files/source.json` records the exact source inputs. The
executable is `files/mpv.app/Contents/MacOS/mpv`. Binary archives contain the
runtime and notices. The release tag identifies the corresponding producer,
owned source and upstream Git pin.
