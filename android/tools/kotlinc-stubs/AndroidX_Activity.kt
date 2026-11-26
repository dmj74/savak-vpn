// androidx.activity surface used by MainActivity — a stub, never compiled by Gradle.
//
// Same bargain as the other stub files in this directory: this proves the app's own code is
// syntactically valid and internally consistent (member names, arity, nullability, visibility)
// with no SDK or Maven access. It does NOT prove the real artifacts agree with these signatures
// — see Android_App.kt for the full statement of that limit. The value is concrete: without
// these, MainActivity.kt cannot be typechecked at all here, and the UI layer is where "it
// compiled on my machine" usually dies.
package androidx.activity

/** Kotlin's `const val` in a superclass companion is *not* inherited into subclass scope, so
 *  Android's Java-static `RESULT_OK` is mirrored on the class the app actually extends. */
open class Activity : android.content.Context() {
    companion object { const val RESULT_OK = -1; const val RESULT_CANCELED = 0 }

    open fun onCreate(savedInstanceState: android.os.Bundle?) {}
    open fun onStart() {}
    open fun onResume() {}
    open fun onPause() {}
    open fun onStop() {}
    open fun onDestroy() {}
}

open class ComponentActivity : Activity() {
    open fun <I, O> registerForActivityResult(
        contract: androidx.activity.result.contract.ActivityResultContract<I, O>,
        callback: androidx.activity.result.ActivityResultCallback<O>,
    ): androidx.activity.result.ActivityResultLauncher<I> = androidx.activity.result.ActivityResultLauncher()
}
