import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

/** Build the original ISF compiler wrappers with their complete static closure. */
export function buildCompilers({work, architectures, sources}) {
  const directory = path.join(work, "compilers"), source = path.join(directory, "source"), build = path.join(directory, "build");
  fs.mkdirSync(source, {recursive: true});
  fs.copyFileSync(path.join(import.meta.dirname, "compiler-CMakeLists.txt"), path.join(source, "CMakeLists.txt"));
  const definitions = {GLSLANG_SOURCE: sources.glslang, SPIRV_CROSS_SOURCE: sources["spirv-cross"],
    SPIRV_TOOLS_SOURCE: sources["spirv-tools"], "SPIRV-Headers_SOURCE_DIR": sources["spirv-headers"]};
  for (const [name, root] of Object.entries(definitions)) if (!root || !fs.existsSync(path.join(root, "CMakeLists.txt")))
    throw Error("Supply the declared ISF compiler source: " + name);
  const python = process.env.MACLAUNCHER_GRAPHICS_PYTHON || execFileSync("uv", ["python", "find", "3.13"], {encoding: "utf8"}).trim();
  const maps = [import.meta.dirname, source, build, ...Object.values(sources)]
    .map((root, index) => "-ffile-prefix-map=" + root + "=ISFCompilerInput" + index).join(" ");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["CFLAGS", "CXXFLAGS", "OBJCFLAGS", "OBJCXXFLAGS", "CPPFLAGS", "LDFLAGS",
    "LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "MACOSX_DEPLOYMENT_TARGET"].includes(name)));
  const run = args => execFileSync("cmake", args, {stdio: "inherit", env});
  run(["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
    "-DCMAKE_OSX_ARCHITECTURES=" + architectures.join(";"), "-DISF_COMPILER_ARCHITECTURES=" + architectures.join(";"),
    "-DCMAKE_C_FLAGS=" + maps, "-DCMAKE_CXX_FLAGS=" + maps, "-DPYTHON_EXECUTABLE=" + python,
    "-DPython3_EXECUTABLE=" + python, "-DCMAKE_SHARED_LINKER_FLAGS=", "-DCMAKE_MODULE_LINKER_FLAGS=", "-DCMAKE_EXE_LINKER_FLAGS=", "-DCMAKE_INSTALL_NAME_DIR=@rpath", "-DCMAKE_BUILD_WITH_INSTALL_NAME_DIR=ON",
    ...Object.entries(definitions).map(([name, root]) => "-D" + name + "=" + root)]);
  run(["--build", build, "--target", "GLSLangValidatorLib", "SPIRVCrossLib", "--parallel", "4"]);
  return [
    {library: path.join(build, "glslang/StandAlone/libGLSLangValidatorLib.dylib"), header: path.join(sources.glslang, "StandAlone/include/GLSLangValidatorLib/GLSLangValidatorLib.hpp")},
    {library: path.join(build, "spirv-cross/libSPIRVCrossLib.dylib"), header: path.join(sources["spirv-cross"], "include/SPIRVCrossLib/SPIRVCrossLib.hpp")}
  ];
}
