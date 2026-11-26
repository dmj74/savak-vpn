// androidx.compose.* — stub for tools/typecheck.sh only; never compiled by Gradle.
package androidx.compose.material3

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp

@RequiresOptIn(level = RequiresOptIn.Level.WARNING, message = "This API is experimental in Material 3.")
annotation class ExperimentalMaterial3Api

class Typography(
    val displaySmall: TextStyle = TextStyle(),
    val titleLarge: TextStyle = TextStyle(),
    val titleMedium: TextStyle = TextStyle(),
    val titleSmall: TextStyle = TextStyle(),
    val bodyLarge: TextStyle = TextStyle(),
    val bodyMedium: TextStyle = TextStyle(),
    val bodySmall: TextStyle = TextStyle(),
    val labelLarge: TextStyle = TextStyle(),
    val labelSmall: TextStyle = TextStyle(),
)

class ColorScheme(
    val primary: Color = Color.Unspecified,
    val onPrimary: Color = Color.Unspecified,
    val surface: Color = Color.Unspecified,
    val onSurface: Color = Color.Unspecified,
    val onSurfaceVariant: Color = Color.Unspecified,
    val background: Color = Color.Unspecified,
    val onBackground: Color = Color.Unspecified,
    val error: Color = Color.Unspecified,
    val onError: Color = Color.Unspecified,
)

/** Upstream: an object for the theme *values* (Local* defaults) plus a composable *function*
 *  that installs them. Both are needed; only one of them would be a compile error in Gradle. */
object MaterialTheme {
    val typography: Typography = Typography()
    val colorScheme: ColorScheme = ColorScheme()
}

@androidx.compose.runtime.Composable
fun MaterialTheme(
    colorScheme: ColorScheme = ColorScheme(),
    typography: Typography = Typography(),
    content: @androidx.compose.runtime.Composable () -> Unit,
) { content() }

@androidx.compose.runtime.Composable
fun Text(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: androidx.compose.ui.unit.TextUnit = androidx.compose.ui.unit.TextUnit.Unspecified,
    fontWeight: FontWeight? = null,
    maxLines: Int = Int.MAX_VALUE,
    textAlign: androidx.compose.ui.text.style.TextAlign? = null,
    style: TextStyle = Typography().bodyLarge,
) { }

@androidx.compose.runtime.Composable
fun Button(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @androidx.compose.runtime.Composable () -> Unit,
) { onClick() }

@androidx.compose.runtime.Composable
fun OutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @androidx.compose.runtime.Composable () -> Unit,
) { onClick() }

@androidx.compose.runtime.Composable
fun TextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @androidx.compose.runtime.Composable () -> Unit,
) { onClick() }

@androidx.compose.runtime.Composable
fun Switch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) { onCheckedChange?.invoke(checked) }

@androidx.compose.runtime.Composable
fun Card(
    modifier: Modifier = Modifier,
    content: @androidx.compose.runtime.Composable ColumnScope.() -> Unit,
) { }

@androidx.compose.runtime.Composable
fun LinearProgressIndicator(modifier: Modifier = Modifier, progress: Float = 0f) { }

@androidx.compose.runtime.Composable
fun Scaffold(
    modifier: Modifier = Modifier,
    topBar: @androidx.compose.runtime.Composable () -> Unit = {},
    content: @androidx.compose.runtime.Composable (androidx.compose.foundation.layout.PaddingValues) -> Unit,
) { content(androidx.compose.foundation.layout.PaddingValues()) }

@androidx.compose.runtime.Composable
fun TopAppBar(
    title: @androidx.compose.runtime.Composable () -> Unit,
    modifier: Modifier = Modifier,
) { }
