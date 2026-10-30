# gomobile's generated classes are reached only through reflection (LibBoxReflect), so R8
# cannot see the usage. Keep them; a renamed binding shows up as "config rejected" on the
# first connect, which is indistinguishable from a censor attack unless we keep it intact.
-keep class org.savak.core.libbox.** { *; }
-keepclassmembers class org.savak.core.libbox.** { public *; }
# Bundle model is parsed with org.json by field name.
-keepclassmembers class ir.savak.client.engine.** { *; }
# Compose + coroutines standard noise
-dontwarn kotlinx.coroutines.**
