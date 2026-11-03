// Root build file. Kept dependency-free on purpose: the engine (Node) does the config
// work, so the only heavy thing in the APK is Compose + the sing-box binding.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
}
