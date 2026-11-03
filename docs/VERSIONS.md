# Package versions

Packages built from product source owned by the publisher use plain semantic versions, such as 0.2.1. A new revision increments the product version. Packages derived from an upstream project use its version with a MacLauncher build revision, such as 1.2.3-MCLv2. Supplied publisher files retain their publisher versions.

Source ownership follows the product repository, separately from the repository containing its build recipe. A pinned-source recipe identifies that repository. A composite producer can declare sourceRepository for its product; dependencies can remain in other repositories. A MacLauncher producer with no foreign upstream sources is owned by its publishing repository. Upstream-derived input groups retain their own version scheme.

The registry declares each release version. Builds of owned source use a plain semantic version. Published versions, tags and package contents are immutable; publishing a new version keeps the earlier record and existing installations.

