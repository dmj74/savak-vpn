// Standalone entry point for tools/typecheck.sh: reads the generated parity fixture and runs
// the same check the JUnit test wraps. Exit code 0 = the Kotlin port matches the engine.
package ir.savak.client.tools

import ir.savak.client.engine.LadderParityCheck
import java.io.File

fun main(args: Array<String>) {
    val fixture = File(args.firstOrNull() ?: "app/src/test/resources/parity/golden.json")
    if (!fixture.isFile) {
        System.err.println("fixture not found: ${fixture.absolutePath}")
        kotlin.system.exitProcess(2)
    }
    val text = fixture.readText()
    if (!LadderParityCheck.checkDetectsMutation(text)) {
        System.err.println("parity check is not detecting a mutated expected score — it would pass on anything")
        kotlin.system.exitProcess(1)
    }
    val report = LadderParityCheck.check(text)
    if (report.ok) {
        println("parity OK · ${report.scenarios} scenarios · ${report.rows} ranking rows · Kotlin port == engine")
    } else {
        println("parity FAILED · ${report.failures.size} of ${report.rows} rows disagree:")
        report.failures.take(20).forEach { println("  · $it") }
        kotlin.system.exitProcess(1)
    }
}
