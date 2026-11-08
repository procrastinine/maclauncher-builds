# Graphics source

Graphics and Vulkan native implementations are maintained in the MacLauncher app repository. The sources/maclauncher Gitlink and app-source.json select the exact app revision. Shared source references point into that checkout. Builds-owned recipes and package staging remain under producers/package-support. Native builds export committed app module files into their build directory.

Package commands set MACLAUNCHER_PACKAGE_PRODUCER=1. Shared size, count and output-buffer guards are unlimited in that process; path checks, digests and tool failures remain active. The app keeps its normal guards. CI initializes the app checkout without recursion and initializes only the independently declared upstream paths for the selected recipe.
