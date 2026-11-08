# Android launcher integrations

This producer builds MacLauncher's Java adapters for launch arguments, text input, account control and the Mac.apk policy, together with the Android JavaScript interfaces that MacLauncher uses. The package is bundled with MacLauncher as an internal component with no user interface of its own, separate from the Android runtime packages.

The `android-launcher` profile of the [included-helper producer](../included-helpers/README.md) lists the files that go into the package. The launch-arguments and Mac.apk policy Java sources are maintained here. The account-control and text-input adapters compile the Android framework's own `AccountControl`, `HostAccountAccess` and `HostTextInput` sources, and the JavaScript interfaces are the Android runtime's files; the `sources/maclauncher-android` gitlink selects both. The JavaScript interfaces keep the directory structure and package metadata that Node's module resolver requires.

The adapters are four JARs, which can be compiled without a MacLauncher checkout from this repository with the Android source gitlink initialized. An explicit JDK 21 home supplies `javac` and `jar`. The Android API classpath lists absolute class directories or JARs, separated by `:`: either the `build/classes` directory and `products/android-framework.jar` of an `android-java-framework` package, or the `android-host.jar` and `android-framework.jar` of an Android runtime, which contain the same classes:

```sh
node producers/android-launcher/build.mjs --jdk /absolute/jdk-home --classpath /absolute/build/classes:/absolute/android-framework.jar --output /absolute/new-output
```

`--only arguments,privacy,text-input,account-control` selects components. Each entry under `source/` takes the same required options and builds one component. The agent adapters target Java 17 with the internal ASM export, and the text-input and account-control adapters target Java 21. The source profiles fix the dates of the JAR members.

The shared Runtime recipe compiles all four JARs from these sources against the `android-java-framework` build input and packages them with the supplied JavaScript interfaces. A missing compiler product stops packaging. Upstream licence texts accompany components when available.
