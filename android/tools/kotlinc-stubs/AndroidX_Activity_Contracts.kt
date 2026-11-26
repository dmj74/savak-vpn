// androidx.activity.result.contract — stub for tools/typecheck.sh only.
//
// Nested inside `ActivityResultContracts` because that is how the app imports it
// (`ActivityResultContracts.StartActivityForResult()`), and a top-level class would let the
// app compile against a shape that does not exist in the artifact.
package androidx.activity.result.contract

abstract class ActivityResultContract<I, O> {
    abstract fun createIntent(context: android.content.Context, input: I): android.content.Intent
}

class ActivityResultContracts {
    class StartActivityForResult : ActivityResultContract<android.content.Intent, androidx.activity.result.ActivityResult>() {
        override fun createIntent(context: android.content.Context, input: android.content.Intent) = input
    }

    class RequestPermission : ActivityResultContract<String, Boolean>() {
        override fun createIntent(context: android.content.Context, input: String) = android.content.Intent()
    }
}
