# Android launcher integrations

This producer contains the owned Java launch-argument, text-input, account-control and Mac.apk policy adapters, the selected Android JavaScript interfaces and the pinned apksig artifact. The package is an invisible included integration dependency. Android execution packages remain managed separately.

The supplied production inputs and licenses are selected by the `android-launcher` included-helper profile. `source.json` identifies the Android source revision, apksig artifact and owned Java source files. The JavaScript interfaces retain the directory structure and package metadata required by Node's module resolver.

The four owned JARs can be compiled without a launcher checkout. An explicit JDK21 home and selected Android runtime directory supply `javac`, `jar`, `android-host.jar` and `android-framework.jar`:

```sh
node producers/android-launcher/build.mjs --jdk /absolute/jdk-home --runtime /absolute/android-runtime --output /absolute/new-output
```

`--only arguments,privacy,text-input,account-control` selects components. The entries under `source/` accept the same required options and build one component each. The agent adapters target Java17 with the internal ASM export; text input and account control target Java21. JAR member dates are fixed by their source profiles. These compilation operations are separate from ordinary app imports and launches.

Package preparation uses `producers/included-helpers/prepare.mjs --id android-launcher` with the supplied directory as input and a new immutable output directory. apksig retains its Apache2.0 notice; the owned adapters and Android interfaces retain their included licenses.
