// On-device link measurement. The phone is the only place that knows what the path
// feels like *now*: which radio, what RTT, whether UDP survives, whether the carrier
// caps a single port. Everything the ladder decides downstream comes from here, so a
// probe that lies is worse than no probe — each measurement degrades to null and the
// selector falls back to the engine's priors instead of guessing.
package ir.savak.client.engine

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

class LinkMeasurer(private val context: Context) {

    fun access(): Access {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return Access.NONE
        val net = cm.activeNetwork ?: return Access.NONE
        val caps = cm.getNetworkCapabilities(net) ?: return Access.OTHER
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Access.WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Access.CELLULAR
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Access.ETHERNET
            else -> Access.OTHER
        }
    }

    /** Both radios up is what makes sing-box's `network_strategy: hybrid` worth anything. */
    fun bothRadiosUp(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val nets = cm.allNetworks ?: return false
        var wifi = false
        var cell = false
        for (n in nets) {
            val c = cm.getNetworkCapabilities(n) ?: continue
            if (!c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) continue
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = true
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) cell = true
        }
        return wifi && cell
    }

    fun pathMtu(): Int? {
        return try {
            val ifs = java.net.NetworkInterface.getNetworkInterfaces()
            var best = 0
            while (ifs.hasMoreElements()) {
                val i = ifs.nextElement()
                if (!i.isUp || i.isLoopback) continue
                if (i.inetAddresses.hasMoreElements() && i.mtu > best) best = i.mtu
            }
            if (best > 0) best else null
        } catch (e: Exception) {
            null
        }
    }

    /**
     * TCP connect time to the node's ports: the RTT any TLS-based rung must pay before
     * its first byte, and the reachability signal that gates a rung out entirely.
     */
    fun tcpRtt(host: String, ports: IntArray, samples: Int = 4, timeoutMs: Int = 1500): Map<Int, PortResult> {
        val out = HashMap<Int, PortResult>()
        for (p in ports) {
            val times = ArrayList<Long>()
            var errors = 0
            repeat(samples) {
                val s = Socket()
                val t0 = System.nanoTime()
                try {
                    s.connect(InetSocketAddress(InetAddress.getByName(host), p), timeoutMs)
                    times.add((System.nanoTime() - t0) / 1_000_000)
                } catch (e: Exception) {
                    errors++
                } finally {
                    runCatching { s.close() }
                }
            }
            out[p] = PortResult(times.sorted(), errors, samples)
        }
        return out
    }

    /**
     * UDP round-trip against the node's probe responder (`server/bootstrap.sh` installs
     * it). Loss here is the number that decides BRUTAL-vs-BBR and QUIC-vs-TCP, so packets
     * are matched by sequence and measured with several in flight — a stop-and-wait probe
     * desynchronises on the first drop and reports someone else's loss.
     */
    fun udpProbes(host: String, port: Int, packets: Int = 24, size: Int = 1200, timeoutMs: Int = 1200): UdpResult {
        val addr = InetAddress.getByName(host)
        val received = HashMap<Int, Long>()
        val sock = DatagramSocket()
        sock.soTimeout = timeoutMs
        val start = System.nanoTime()
        val seqAt = HashMap<Int, Long>()
        val reader = thread(name = "savak-udp-probe") {
            val buf = ByteArray(2048)
            val pkt = DatagramPacket(buf, buf.size)
            try {
                while (System.nanoTime() - start < (timeoutMs + packets * 20L) * 1_000_000) {
                    sock.receive(pkt)
                    if (pkt.length < 10) continue
                    val magic = String(pkt.data, 0, 6, Charsets.US_ASCII)
                    if (magic != "SAVAKR") continue
                    val seq = ((pkt.data[6].toInt() and 0xff) shl 24) or ((pkt.data[7].toInt() and 0xff) shl 16) or
                        ((pkt.data[8].toInt() and 0xff) shl 8) or (pkt.data[9].toInt() and 0xff)
                    received.putIfAbsent(seq, (System.nanoTime() - start) / 1_000_000)
                }
            } catch (_: Exception) {
                // socket closed or timeout: whatever arrived is the measurement
            }
        }
        val payload = ByteArray(size)
        for (i in 0 until packets) {
            "SAVAKQ".toByteArray(Charsets.US_ASCII).copyInto(payload, 0)
            payload[6] = (i ushr 24).toByte()
            payload[7] = (i ushr 16).toByte()
            payload[8] = (i ushr 8).toByte()
            payload[9] = i.toByte()
            seqAt[i] = (System.nanoTime() - start) / 1_000_000
            runCatching { sock.send(DatagramPacket(payload, payload.size, addr, port)) }
            Thread.sleep(12)
        }
        reader.join(timeoutMs + 400L)
        runCatching { sock.close() }

        val rtts = received.entries.map { it.value - (seqAt[it.key] ?: it.value) }.sorted()
        val median = if (rtts.isEmpty()) null else rtts[rtts.size / 2]
        val jitter = median?.let { m -> rtts.map { kotlin.math.abs(it - m) }.sorted()?.getOrNull(rtts.size / 2) }
        return UdpResult(
            sent = packets,
            received = received.size,
            lossPct = (packets - received.size) * 100.0 / packets,
            rttMs = median?.toDouble(),
            jitterMs = jitter?.toDouble(),
            blocked = received.isEmpty(),
        )
    }

    /**
     * "UDP is throttled" vs "one port is throttled" need different answers, so measure
     * both: same-byte-count transfers over UDP and over TCP, plus a second UDP port.
     */
    fun classifyUdp(host: String, tunnelPort: Int, probeUdpPort: Int, probeTcpPort: Int): UdpVerdict {
        val udp = udpProbes(host, probeUdpPort, packets = 12, size = 1200)
        val tcp = tcpRtt(host, intArrayOf(probeTcpPort, tunnelPort), samples = 3)
        val tcpOk = tcp.values.any { it.connected > 0 }
        return UdpVerdict(
            udpBlocked = udp.blocked && tcpOk,
            udpThrottled = !udp.blocked && udp.lossPct > 25 && tcpOk,
            portThrottled = !udp.blocked && udp.lossPct in 8.0..25.0,
            tcpReachable = tcpOk,
        )
    }

    fun snapshot(host: String, ports: IntArray, probeUdpPort: Int = 20125, probeTcpPort: Int = 20126): LinkSnapshot {
        val tcp = tcpRtt(host, ports)
        val best = tcp.values.filter { it.connected > 0 }.minByOrNull { it.medianMs ?: Double.MAX_VALUE }
        val udp = runCatching { udpProbes(host, probeUdpPort, packets = 16) }.getOrNull()
        val tp = runCatching { throughput(host, probeTcpPort, seconds = 2) }.getOrNull()
        return LinkSnapshot(
            access = access(),
            rttMs = best?.medianMs,
            jitterMs = udp?.jitterMs,
            lossPct = udp?.lossPct?.takeIf { udp.received > 0 },
            downMbps = tp?.mbps,
            upMbps = tp?.let { it.mbps * 0.35 },
            mtuCap = pathMtu(),
            udpBlocked = udp?.blocked,
            quicBlocked = udp?.blocked,
            udpThrottled = udp?.let { !it.blocked && it.lossPct > 25 },
            portThrottled = udp?.let { !it.blocked && it.lossPct in 8.0..25.0 },
            // Explicit, not derived inside the model: a scorer that infers "TCP only" from
            // "UDP blocked" would disagree with a fixture that does not, and both are right
            // on their own terms. The measurement decides.
            tcpOnly = udp?.blocked == true,
            bothRadios = bothRadiosUp(),
            source = if (best == null && udp == null) "degraded" else "measured",
        )
    }

    data class Throughput(val mbps: Double, val bytes: Long, val seconds: Double)

    fun throughput(host: String, port: Int, seconds: Int): Throughput {
        val s = Socket(InetAddress.getByName(host), port)
        s.soTimeout = (seconds + 6) * 1000
        s.getOutputStream().write("GET $seconds\n".toByteArray())
        val buf = ByteArray(64 * 1024)
        var total = 0L
        val t0 = System.nanoTime()
        var last = t0
        while ((System.nanoTime() - t0) / 1_000_000_000.0 < seconds) {
            val n = try { s.getInputStream().read(buf) } catch (e: Exception) { -1 }
            if (n <= 0) break
            total += n
            last = System.nanoTime()
        }
        runCatching { s.close() }
        val elapsed = ((last - t0).coerceAtLeast(1L)) / 1_000_000_000.0
        return Throughput(total * 8.0 / elapsed / 1e6, total, elapsed)
    }

    data class PortResult(val rtts: List<Long>, val failures: Int, val samples: Int) {
        val connected: Int get() = samples - failures
        val medianMs: Double? get() = rtts.getOrNull(rtts.size / 2)?.toDouble()
    }

    data class UdpResult(val sent: Int, val received: Int, val lossPct: Double, val rttMs: Double?, val jitterMs: Double?, val blocked: Boolean)

    data class UdpVerdict(val udpBlocked: Boolean, val udpThrottled: Boolean, val portThrottled: Boolean, val tcpReachable: Boolean)
}
