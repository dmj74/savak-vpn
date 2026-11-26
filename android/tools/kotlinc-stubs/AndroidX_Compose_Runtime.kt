// androidx.compose.runtime — stub for tools/typecheck.sh only; never compiled by Gradle.
//
// What this leg proves and what it does not, precisely:
//   PROVES  the app's own code is consistent — that MainActivity calls SavakViewModel /
//           BundleHolder / TunnelPrefs / parseBundle / LadderTable with names, arity and
//           nullability that exist. That boundary (UI ↔ engine/service) is where this project
//           actually breaks, and until these stubs existed it was checked by reading alone.
//   DOES NOT PROVE that androidx's signatures are right (no Compose plugin, no runtime jars:
//           the compiler is not enforcing @Composable call rules, slot tables or recomposition
//           scopes). A shared misreading of an androidx signature passes here and fails in
//           Gradle — same limit as every other file in this directory.
package androidx.compose.runtime

@Target(
    AnnotationTarget.FUNCTION,
    AnnotationTarget.TYPE,
    AnnotationTarget.PROPERTY_GETTER,
    AnnotationTarget.PROPERTY_SETTER,
    AnnotationTarget.CONSTRUCTOR,
)
@Retention(AnnotationRetention.SOURCE)
annotation class Composable

interface State<out T> { val value: T }

interface MutableState<T> : State<T> { override var value: T }

/** `val state by vm.state.collectAsState()` — the delegate operator Compose provides. */
operator fun <T> State<T>.getValue(thisObj: Any?, property: kotlin.reflect.KProperty<*>): T = value

operator fun <T> MutableState<T>.setValue(thisObj: Any?, property: kotlin.reflect.KProperty<*>, v: T) { value = v }

/** StateFlow → State. Real Compose has both overloads; the app uses the StateFlow one. */
fun <T> kotlinx.coroutines.flow.StateFlow<T>.collectAsState(): State<T> = object : State<T> {
    override val value: T get() = this@collectAsState.value
}

fun <T> kotlinx.coroutines.flow.Flow<T>.collectAsState(initial: T): State<T> = object : State<T> {
    override val value: T get() = initial
}
