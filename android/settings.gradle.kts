pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // The sing-box libbox AAR is produced by `gomobile bind` (see android/README.md);
        // publish it to a local maven repo rather than committing a binary blob.
        maven(url = uri("../third_party/maven"))
    }
}
rootProject.name = "savak-client"
include(":app")
