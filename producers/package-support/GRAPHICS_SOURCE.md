# Graphics source

Graphics and Vulkan native implementations are maintained in the MacLauncher app repository. `app-source.json` and the `sources/maclauncher` Git pin select the complete source revision. Relative source links refer to that pin; the producer verifies it before building and exports committed module files for the native build. Source links are materialized as regular pinned files for provider validation and restored after the producer finishes.

Builds maintains package recipes, manifests, dependency pins and licence inputs. The native graphics materializer combines the pinned app module with those producer inputs. MoltenVK applies the temporal carrier overlay before the scene overlay, using the same pinned app headers and implementations.
