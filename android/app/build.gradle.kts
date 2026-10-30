import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * Release signing is operator-local and gitignored: `server/release-signing.properties`
 * holds `storeFile=` and `keyAlias=` (passwords come from the environment, never a file).
 * The *trust anchors for profile signatures* are a different thing and must not live here —
 * they are compiled into the APK (MainActivity.TrustedKeys), because a key fetched at
 * runtime is exactly as untrustworthy as the config it signs.
 */
val signingPropsFile = rootProject.file("../server/release-signing.properties")

android {
    namespace = "ir.savak.client"
    compileSdk = 35

    defaultConfig {
        applicationId = "ir.savak.client"
        minSdk = 26          // API 26: VpnService.Builder.setBlocking + Java 8 time
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-engine"
        ndk {
            // The libbox AAR is a gomobile artifact: it carries cgo .so files for these ABIs.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
        buildConfigField("String", "SINGBOX_VERSION", "\"1.14.4\"")
        buildConfigField("boolean", "USE_SUBPROCESS_BACKEND", "false")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        if (signingPropsFile.exists()) {
            val p = Properties().apply { FileInputStream(signingPropsFile).use { load(it) } })
            create("release") {
                // Keystore details come from the operator's env, never from the repo.
                storeFile = p.getProperty("storeFile")?.let { file(it) }
                storePassword = System.getenv("SAVAK_KEYSTORE_PASSWORD")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = System.getenv("SAVAK_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
        getByName("release") {
            // R8 must not rename the reflection targets in LibBoxReflect: the binding class
            // names are fixed by gomobile, so keep them and fail loudly if the AAR changes.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (signingPropsFile.exists()) signingConfigs.getByName("release") else null
            // An unsigned "release" APK is how people install something they cannot tell
            // apart from the real one — so say it out loud rather than producing silently.
            if (!signingPropsFile.exists() && !gradle.startParameter.taskNames.any { it.contains("Debug") }) {
                logger.warn("savak: no signing config at server/release-signing.properties — :app:assembleRelease will produce an unsigned APK")
            }
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "kotlin/**", "DebugProbesKt.bin")
        jniLibs.useLegacyPackaging = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
    }
    lint {
        // A missing translation for a hard-coded Persian string is not a build failure,
        // and `QueryAllPackagesPermission` is deliberate (per-app routing needs it).
        disable += setOf("MissingTranslation", "QueryAllPackagesPermission", "OldTargetApi")
        abortOnError = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.02")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06") // prefs at rest

    // gomobile binding for sing-box 1.14.4 — built locally, see android/README.md.
    implementation("org.savak.core:libbox:1.14.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // JSONObject in JVM unit tests
    testImplementation("com.google.truth:truth:1.4.4")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
