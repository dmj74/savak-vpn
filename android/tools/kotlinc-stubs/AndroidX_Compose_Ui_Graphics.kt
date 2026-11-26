// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.ui.graphics

@JvmInline
value class Color(val value: Long) {
    companion object {
        val Red = Color(0xFFFF0000)
        val Green = Color(0xFF00FF00)
        val Blue = Color(0xFF0000FF)
        val Black = Color(0xFF000000)
        val White = Color(0xFFFFFFFF)
        val Transparent = Color(0x00000000)
        val Unspecified = Color(Long.MIN_VALUE)
    }
}
