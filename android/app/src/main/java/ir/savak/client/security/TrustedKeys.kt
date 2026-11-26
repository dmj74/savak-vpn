// Trust anchors for profile signatures.
//
// This is the file that decides whether a bundle is accepted at all. It is *empty on purpose*
// in a clean checkout: `ProfileVerifier` refuses every profile when `map` has no entry, so a
// build that forgot to install an anchor fails on the phone with a visible error instead of
// trusting whatever was packed into the APK.
//
// Do not hand-edit it if you can avoid it — `savak app-assets --androidDir android …` writes a
// matching pair (this key + the profile that `savak bundle` signed with it), which is the one
// arrangement where "the signature verified" means what it sounds like. The engine only
// overwrites files carrying the `savak:generated` marker; a hand-maintained file like this one
// is left alone and reported.
package ir.savak.client.security

object TrustedKeys {
    /** keyId → PEM public key (the same form `savak init` prints for this purpose). */
    val map: Map<String, String> = emptyMap()
}
