// androidx.activity.result + androidx.activity.compose — stubs for tools/typecheck.sh only.
package androidx.activity.result

/** Java's SAM type; a `fun interface` so the app's lambda passes exactly as it does upstream. */
fun interface ActivityResultCallback<O> { fun onActivityResult(result: O) }

class ActivityResultLauncher<I> { fun launch(input: I) {} fun unregister() {} }

data class ActivityResult(val resultCode: Int = 0, val data: android.content.Intent? = null)
