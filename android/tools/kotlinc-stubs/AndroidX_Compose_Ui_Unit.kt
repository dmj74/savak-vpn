// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.ui.unit

@JvmInline
value class Dp(val value: Float) {
    companion object { val Hairline: Dp = Dp(0f) }
}

val Int.dp: Dp get() = Dp(this.toFloat())
val Float.dp: Dp get() = Dp(this)
val Double.dp: Dp get() = Dp(this.toFloat())

@JvmInline
value class TextUnit(val value: Float) {
    companion object { val Unspecified: TextUnit = TextUnit(Float.NaN) }
}
