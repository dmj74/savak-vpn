// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.ui.text.font

@JvmInline
value class FontWeight(val weight: Int) {
    companion object {
        val Thin = FontWeight(100)
        val Normal = FontWeight(400)
        val Medium = FontWeight(500)
        val SemiBold = FontWeight(600)
        val Bold = FontWeight(700)
    }
}

interface FontFamily
