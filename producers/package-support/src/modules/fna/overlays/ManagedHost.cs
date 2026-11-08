using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Threading.Tasks;

// The host runs in a separate native process. Arguments are the game's entry
// assembly and the runtime directory. MACLAUNCHER_FNA_GAME_ROOT names the
// original game directory, which stays the working and base directory, as for
// a game started in place. MACLAUNCHER_FNA_ASSEMBLY_ROOT holds only derived
// (retargeted) copies of game assemblies, searched before the original files.
// MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK=1 selects the runtime package's FNA and
// XNA facades over the game's; the package's deps file lists only the host, so
// the CLR leaves that choice to this resolver. The package's launcher contract
// keeps it from launchers that do not set these variables.
internal static class ManagedHost
{
    private static string gameRoot = "";
    private static string runtimeRoot = "";
    private static string[] assemblyRoots = Array.Empty<string>();
    private static bool runtimeFramework;

    private static IntPtr ResolveNative(string name, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (name.Contains('/') || name.Contains('\\')) return IntPtr.Zero;
        string stem = name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
        // Prefer the ABI soname also linked by FNA3D/FAudio. Distributions can
        // contain regular-file aliases; loading both SDL names would create two
        // independent SDL instances (and duplicate Objective-C classes on macOS).
        foreach (string candidate in new[] { stem, "lib" + stem + ".0.dylib", "lib" + stem + ".dylib" })
        {
            string file = Path.Combine(runtimeRoot, "native", "lib", candidate);
            if (File.Exists(file)) return NativeLibrary.Load(file);
        }
        return IntPtr.Zero;
    }

    // An assembly can set its own resolver from its module initializer, as FNA
    // built for .NET 7 or later does (FNADllMap). Run that initializer first and
    // keep its resolver; only one resolver can be set per assembly.
    private static void UseRuntimeNatives(Assembly assembly)
    {
        RuntimeHelpers.RunModuleConstructor(assembly.ManifestModule.ModuleHandle);
        try { NativeLibrary.SetDllImportResolver(assembly, ResolveNative); }
        catch (InvalidOperationException) { }
    }

    private static string? FindAssembly(AssemblyName name)
    {
        string culture = name.CultureName ?? "";
        if (String.IsNullOrEmpty(name.Name) || (name.Name + culture).IndexOfAny(new[] { '/', '\\' }) >= 0) return null;
        string file = name.Name + ".dll";
        bool xna = name.Name.StartsWith("Microsoft.Xna.Framework", StringComparison.Ordinal);
        string framework = xna ? Path.Combine(runtimeRoot, "abi", file) : Path.Combine(runtimeRoot, file);
        if (runtimeFramework && (xna || name.Name == "FNA") && File.Exists(framework)) return framework;
        // Derived copies come before the original files; satellite assemblies
        // keep their culture directory.
        foreach (string root in assemblyRoots)
        {
            string candidate = Path.Combine(root, culture, file);
            if (File.Exists(candidate)) return candidate;
        }
        return xna && File.Exists(framework) ? framework : null;
    }

    private static Assembly? ResolveAssembly(AssemblyLoadContext context, AssemblyName name)
    {
        string? file = FindAssembly(name);
        if (file == null) return null;
        Assembly loaded = context.LoadFromAssemblyPath(file);
        UseRuntimeNatives(loaded);
        return loaded;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("FNA host requires a game assembly and runtime directory.");
            string gameFile = Path.GetFullPath(args[0]);
            runtimeRoot = Path.GetFullPath(args[1]);
            string? originalRoot = Environment.GetEnvironmentVariable("MACLAUNCHER_FNA_GAME_ROOT");
            if (String.IsNullOrEmpty(originalRoot)) throw new ArgumentException("FNA host requires MACLAUNCHER_FNA_GAME_ROOT.");
            gameRoot = Path.GetFullPath(originalRoot);
            string? derivedRoot = Environment.GetEnvironmentVariable("MACLAUNCHER_FNA_ASSEMBLY_ROOT");
            assemblyRoots = String.IsNullOrEmpty(derivedRoot) ? new[] { gameRoot } : new[] { Path.GetFullPath(derivedRoot), gameRoot };
            runtimeFramework = Environment.GetEnvironmentVariable("MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK") == "1";
            Directory.SetCurrentDirectory(gameRoot);
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", gameRoot + Path.DirectorySeparatorChar);
            AssemblyLoadContext.Default.Resolving += ResolveAssembly;
            AssemblyLoadContext.Default.ResolvingUnmanagedDll += (assembly, name) => ResolveNative(name, assembly, null);
            // Preload the selected framework so its P/Invoke bindings always
            // resolve against the reviewed native dependency directory.
            string? frameworkFile = FindAssembly(new AssemblyName("FNA"));
            if (frameworkFile != null) UseRuntimeNatives(AssemblyLoadContext.Default.LoadFromAssemblyPath(frameworkFile));
            Assembly game = AssemblyLoadContext.Default.LoadFromAssemblyPath(gameFile);
            // The game is the process entry assembly, as when it starts directly.
            // AppDomain.FriendlyName follows it, which names FNA's storage folder;
            // FNA's default window title and games' Location-based content paths
            // read it too. .NET 8 implements this .NET 9 API without exposing it
            // in its reference assemblies.
            typeof(Assembly).GetMethod("SetEntryAssembly", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, new object[] { game });
            UseRuntimeNatives(game);
            MethodInfo entry = game.EntryPoint ?? throw new InvalidOperationException("Game assembly has no managed entry point.");
            Console.WriteLine("[maclauncher-fna] Game " + game.GetName().Name + " " + game.GetName().Version);
            Console.WriteLine("[maclauncher-fna] Host .NET " + Environment.Version + " " + RuntimeInformation.ProcessArchitecture);
            object? result = entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { args.Skip(2).ToArray() });
            if (result is Task<int> exit) return exit.GetAwaiter().GetResult();
            if (result is Task task) { task.GetAwaiter().GetResult(); return 0; }
            return result is int code ? code : 0;
        }
        catch (Exception error)
        {
            Exception failure = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            Console.Error.WriteLine("[maclauncher-fna] " + failure);
            return 1;
        }
    }
}
