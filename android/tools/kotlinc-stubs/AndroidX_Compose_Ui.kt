// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.ui

/**
 * `Modifier` is an interface whose companion *is* the empty element — that is why app code can
 * write `Modifier.fillMaxWidth()` and chain. The chain methods are declared here as members so
 * a typo inside a chain (`.fillMaxWidt()`) still fails, which is most of the point.
 */
interface Modifier {
    fun then(other: Modifier): Modifier = other
    companion object : Modifier
}

interface Alignment {
    interface Horizontal
    interface Vertical
    interface HorizontalOrVertical : Horizontal, Vertical

    object Start : Horizontal
    object CenterHorizontally : Horizontal
    object End : Horizontal
    object Top : Vertical
    object CenterVertically : Vertical
    object Bottom : Vertical
    object Center : HorizontalOrVertical
}
