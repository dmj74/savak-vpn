// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.foundation.lazy

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.Modifier

interface LazyListScope {
    fun items(count: Int, itemContent: @androidx.compose.runtime.Composable (index: Int) -> Unit)
}

/** `items(list) { … }` is an extension upstream, and it is what the app imports. */
fun <T> LazyListScope.items(
    items: List<T>,
    itemContent: @androidx.compose.runtime.Composable (item: T) -> Unit,
) {
    items(items.size) { index -> itemContent(items[index]) }
}

@androidx.compose.runtime.Composable
fun LazyColumn(
    modifier: Modifier = Modifier,
    verticalArrangement: Arrangement.Vertical = Arrangement.Top,
    content: @androidx.compose.runtime.Composable LazyListScope.() -> Unit,
) { }
