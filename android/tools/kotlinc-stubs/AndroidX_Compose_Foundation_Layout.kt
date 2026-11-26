// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.foundation.layout

import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp

/**
 * `Arrangement.spacedBy(8.dp)` must satisfy both `horizontalArrangement` and
 * `verticalArrangement` — upstream models that as one `HorizontalOrVertical` type, so the
 * stub does too rather than declaring two same-typed overloads that would not compile.
 */
class Arrangement {
    interface Horizontal
    interface Vertical
    interface HorizontalOrVertical : Horizontal, Vertical

    private class Spaced : HorizontalOrVertical

    companion object {
        val Start: Horizontal = object : Horizontal {}
        val Top: Vertical = object : Vertical {}
        fun spacedBy(space: Dp): HorizontalOrVertical = Spaced()
        fun spacedBy(space: Dp, alignment: Alignment.Horizontal): HorizontalOrVertical = Spaced()
        fun spacedBy(space: Dp, alignment: Alignment.Vertical): HorizontalOrVertical = Spaced()
    }
}

class PaddingValues(val all: Dp = Dp(0f))

interface ColumnScope
interface RowScope
interface BoxScope

fun Modifier.fillMaxSize(fraction: Float = 1f): Modifier = this
fun Modifier.fillMaxWidth(fraction: Float = 1f): Modifier = this
fun Modifier.fillMaxHeight(fraction: Float = 1f): Modifier = this
fun Modifier.padding(all: Dp): Modifier = this
fun Modifier.padding(contentPadding: PaddingValues): Modifier = this
fun Modifier.width(width: Dp): Modifier = this
fun Modifier.height(height: Dp): Modifier = this

@androidx.compose.runtime.Composable
fun Column(
    modifier: Modifier = Modifier,
    verticalArrangement: Arrangement.Vertical = Arrangement.Top,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: @androidx.compose.runtime.Composable ColumnScope.() -> Unit,
) { }

@androidx.compose.runtime.Composable
fun Row(
    modifier: Modifier = Modifier,
    horizontalArrangement: Arrangement.Horizontal = Arrangement.Start,
    verticalAlignment: Alignment.Vertical? = null,
    content: @androidx.compose.runtime.Composable RowScope.() -> Unit,
) { }

@androidx.compose.runtime.Composable
fun Box(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment? = null,
    content: @androidx.compose.runtime.Composable BoxScope.() -> Unit,
) { }

@androidx.compose.runtime.Composable
fun Spacer(modifier: Modifier = Modifier) { }
