# Android launcher integrations

This producer builds MacLauncher's Java adapters for launch arguments, text input, account control and the Mac.apk policy, together with the Android JavaScript interfaces that MacLauncher uses. The package is bundled with MacLauncher as an internal component with no user interface of its own, separate from the Android runtime packages.

The `android-launcher` profile of the [included-helper producer](../included-helpers/README.md) lists the files that go into the package and their licenses. `source.json` records the commit of the Android source project, the supplied files and the Java source files maintained here. The JavaScript interfaces keep the directory structure and package metadata that Node's module resolver requires.

The adapters are four JARs, which can be compiled without a MacLauncher checkout. An explicit JDK 21 home and the selected Android runtime directory supply `javac`, `jar`, `android-host.jar` and `android-framework.jar`:

```sh
node producers/android-launcher/build.mjs --jdk /absolute/jdk-home --runtime /absolute/android-runtime --output /absolute/new-output
```

`--only arguments,privacy,text-input,account-control` selects components. Each entry under `source/` takes the same required options and builds one component. The agent adapters target Java 17 with the internal ASM export, and the text-input and account-control adapters target Java 21. The source profiles fix the dates of the JAR members.

To prepare the package, `producers/included-helpers/prepare.mjs --id android-launcher` takes the supplied directory as input and writes a new output directory. The adapters and Android interfaces keep their included licenses.
