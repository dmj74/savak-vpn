// Package-manager surface used by the split-tunnel / strict-route allow-list.
package android.content.pm

open class ApplicationInfo(open val packageName: String = "")

/** Only what savak reads: the installed package list, for the strict-route allow-list. */
class PackageManager {
    fun getInstalledApplications(flags: Int): List<ApplicationInfo> = emptyList()
}
