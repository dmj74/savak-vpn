import java.io.File

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
        // The sing-box libbox AAR, built by `gomobile bind` and installed by
        // tools/build-libbox.sh into android/third_party/maven (gitignored — committing a binary
        // blob nobody can audit is the alternative, and it is worse). Anchored to `settingsDir`
        // because a relative `../` here resolves *outside* android/ and the symptom is
        // "Could not find org.savak.core:libbox" in a log that blames the AAR, not this line.
        // `setUrl(File(..))` rather than `uri()` for the same reason: an unresolvable path should
        // not be one Gradle-version quirk away from happening. Override with
        // -Psavak.libbox.repo=/abs/path (CI, or a build farm that caches the AAR elsewhere).
        maven {
            val dir = providers.gradleProperty("savak.libbox.repo").getOrElse("third_party/maven")
            setUrl(if (dir.startsWith("/")) File(dir) else File(settingsDir, dir))
        }
    }
}
rootProject.name = "savak-client"
include(":app")
