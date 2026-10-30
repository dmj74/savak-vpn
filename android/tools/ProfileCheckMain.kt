// Runs the phone's profile verification over a bundle built by the engine: same canonical
// JSON, same Ed25519, same trust rule. A mismatch here is not a style problem — it means
// every device would refuse a legitimate profile (or, worse, accept a forged one).
package ir.savak.client.tools

import ir.savak.client.security.ProfileVerifier
import org.json.JSONObject
import java.io.File

fun main(args: Array<String>) {
    if (args.size < 3) {
        System.err.println("usage: ProfileCheckMain <profile.json> <keyId> <publicKeyBase64>")
        kotlin.system.exitProcess(2)
    }
    val profile = JSONObject(File(args[0]).readText())
    val trusted = mapOf(args[1] to args[2])

    val good = ProfileVerifier.verify(profile, trusted)
    val verdict = if (good.ok) "OK" else "REJECTED"
    println("verify(profile)            -> $verdict  (${good.reason})")

    // Tamper: send the node's traffic somewhere else. Must break the signature.
    val tampered = JSONObject(profile.toString())
    tampered.getJSONArray("servers").getJSONObject(0).put("address", "evil.example")
    val bad = ProfileVerifier.verify(tampered, trusted)
    println("verify(tampered address)   -> " + if (bad.ok) "ACCEPTED   <-- BUG" else "REJECTED (correct)")

    // An unknown signing key must refuse even a perfectly signed document.
    val unknown = ProfileVerifier.verify(profile, mapOf("nope" to args[2]))
    println("verify(unknown keyId)      -> " + if (unknown.ok) "ACCEPTED   <-- BUG" else "REJECTED (correct)")

    // No anchors at all: refuse, never fall back to "unsigned is fine".
    val none = ProfileVerifier.verify(profile, emptyMap())
    println("verify(no trusted keys)    -> " + if (none.ok) "ACCEPTED   <-- BUG" else "REJECTED (correct)")

    if (!good.ok || bad.ok || unknown.ok || none.ok) kotlin.system.exitProcess(1)
    println("profile trust model OK (canonical JSON + Ed25519 agree with the engine)")
}
