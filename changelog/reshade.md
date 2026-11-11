# MacLauncher graphics

## 0.3.11

Added scene-input upscaling and effects for games that supply FidelityFX scene inputs. Turning Graphics off returns upscaling dispatches to the game's original FidelityFX library.

Fixed retained scene images exhausting processing capacity and preserved completed images through presentation updates. Screenshots capture the game's frame when Graphics is off.

Fixed a startup crash in games that clear unordered access views during initialization.

## 0.3.10

Shader options support preset import from `.slangp` and `.ini` files, plus clipboard copy and paste.
