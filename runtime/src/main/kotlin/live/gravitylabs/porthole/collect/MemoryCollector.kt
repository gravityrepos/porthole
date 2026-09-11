// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.os.Debug
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.nowMs
import live.gravitylabs.porthole.store.EventRing
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Java heap, native heap, and GC pressure, sampled on a timer.
 *
 * Sampled rather than hooked because there is nothing to hook: the runtime does
 * not announce allocations, and asking after every one would cost more than the
 * thing being measured. A second is fine for watching a heap climb, and is well
 * under the resolution at which anyone reads a memory graph.
 *
 * What this is not: leak detection. Knowing the heap grew says nothing about
 * what is holding it, which needs a heap dump and a dominator tree — LeakCanary's
 * job, not a socket's. Growth that never comes back down is the signal offered
 * here, and it is a hint to go looking, not a finding.
 */
internal class MemoryCollector(private val ring: EventRing) {

    private val worker = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "porthole-memory").apply { isDaemon = true }
    }

    @Volatile
    private var lastGcCount = -1L

    @Volatile
    private var lastBlockingCount = -1L

    @Volatile
    private var lastBlockingTimeMs = -1L

    @Volatile
    private var lastAllocated = -1L

    @Volatile
    private var lastFreed = -1L

    @Volatile
    private var lastSampleAt = 0L

    private var sampleIndex = 0

    /** Last PSS reading, carried between the samples that do not take one. */
    private var pss: IntArray? = null

    fun start() {
        worker.scheduleWithFixedDelay(::sample, 0, SAMPLE_MS, TimeUnit.MILLISECONDS)
    }

    fun stop() {
        worker.shutdownNow()
    }

    private fun sample() {
        runCatching {
            val runtime = Runtime.getRuntime()
            val max = runtime.maxMemory()
            val used = runtime.totalMemory() - runtime.freeMemory()
            val native = Debug.getNativeHeapAllocatedSize()

            // Every counter here is cumulative since process start, so what
            // gets reported is the delta. The first sample has nothing to
            // subtract from and reports zero rather than a lifetime total
            // masquerading as a second's worth.
            val gcCount = stat("art.gc.gc-count")
            val blockingCount = stat("art.gc.blocking-gc-count")
            val blockingTimeMs = stat("art.gc.blocking-gc-time") / 1_000_000
            val allocated = stat("art.gc.bytes-allocated")
            val freed = stat("art.gc.bytes-freed")

            val now = nowMs()
            val elapsed = if (lastSampleAt == 0L) 0L else now - lastSampleAt
            lastSampleAt = now

            val sinceLast = delta(gcCount, lastGcCount)
            val blockingSince = delta(blockingCount, lastBlockingCount)
            val blockingMsSince = delta(blockingTimeMs, lastBlockingTimeMs)
            val allocatedSince = delta(allocated, lastAllocated)
            val freedSince = delta(freed, lastFreed)

            if (gcCount >= 0) lastGcCount = gcCount
            if (blockingCount >= 0) lastBlockingCount = blockingCount
            if (blockingTimeMs >= 0) lastBlockingTimeMs = blockingTimeMs
            if (allocated >= 0) lastAllocated = allocated
            if (freed >= 0) lastFreed = freed

            // A collection is its own thing that happened at a time, not a
            // number hanging off a sample, so it gets its own event and can be
            // clicked like anything else on the timeline.
            if (sinceLast > 0) {
                ring.emit(
                    "gc",
                    JsonObject(
                        buildMap {
                            put("count", JsonPrimitive(sinceLast))
                            put("heapUsedMb", JsonPrimitive(mb(used)))
                            put("heapMaxMb", JsonPrimitive(mb(max)))
                            if (blockingSince > 0) put("blocking", JsonPrimitive(blockingSince))
                            if (blockingMsSince > 0) put("pausedMs", JsonPrimitive(blockingMsSince))
                            if (freedSince > 0) put("freedMb", JsonPrimitive(mb(freedSince)))
                        },
                    ),
                )
            }

            ring.emit(
                "memory",
                JsonObject(
                    buildMap {
                        put("heapUsedMb", JsonPrimitive(mb(used)))
                        put("heapMaxMb", JsonPrimitive(mb(max)))
                        put("heapPercent", JsonPrimitive(if (max > 0) (used * 100 / max).toInt() else 0))
                        put("nativeMb", JsonPrimitive(mb(native)))
                        // Total RAM charged to this process, which is the number
                        // a profiler shows and is always larger than the heap:
                        // code, graphics buffers and native allocations are in
                        // it too. Read on a slower cadence than the rest.
                        totalRam()?.let { stats ->
                            put("totalRamMb", JsonPrimitive(stats[0]))
                            put("javaRamMb", JsonPrimitive(stats[1]))
                            put("nativeRamMb", JsonPrimitive(stats[2]))
                            put("graphicsRamMb", JsonPrimitive(stats[3]))
                        }
                        put("threads", JsonPrimitive(threadCount()))
                        put("gcSinceLast", JsonPrimitive(sinceLast))
                        put("gcTotal", JsonPrimitive(gcCount))
                        // The collections that stopped the app rather than ran
                        // beside it. These are the ones that show up as jank.
                        if (blockingSince > 0) put("blockingGc", JsonPrimitive(blockingSince))
                        if (blockingMsSince > 0) put("blockingGcMs", JsonPrimitive(blockingMsSince))
                        // Reported in KB/s, not MB/s. An app ticking over
                        // allocates a few hundred KB a second, and integer MB
                        // rounds every bit of that to zero — which reads as "no
                        // allocation" when the truth is "a normal amount".
                        if (allocatedSince > 0 && elapsed > 0) {
                            val perSecond = allocatedSince * 1000 / elapsed
                            put("allocKbPerSec", JsonPrimitive(perSecond / 1024))
                        }
                        if (allocated >= 0) put("allocTotalMb", JsonPrimitive(mb(allocated)))
                    },
                ),
            )
        }
    }

    /** ART exposes these as strings, and not on every device. */
    private fun stat(name: String): Long =
        runCatching { Debug.getRuntimeStat(name)?.toLong() ?: -1L }.getOrDefault(-1L)

    /**
     * Total, Java, native and graphics RAM in MB, or null if never read.
     *
     * Debug.getMemoryInfo walks the process's memory maps, which costs far more
     * than the rest of a sample put together, so it runs every fifth one and the
     * value in between is the last one taken. A number that is up to five
     * seconds old is worth far more than a per-second sample that shows up in
     * its own frame timings.
     */
    private fun totalRam(): IntArray? {
        if (sampleIndex++ % PSS_EVERY == 0) {
            runCatching {
                val info = Debug.MemoryInfo()
                Debug.getMemoryInfo(info)
                pss = intArrayOf(
                    info.totalPss / 1024,
                    stat(info, "summary.java-heap"),
                    stat(info, "summary.native-heap"),
                    stat(info, "summary.graphics"),
                )
            }
        }
        return pss
    }

    private fun stat(info: Debug.MemoryInfo, key: String): Int =
        runCatching { (info.getMemoryStat(key)?.toInt() ?: 0) / 1024 }.getOrDefault(0)

    private fun delta(current: Long, previous: Long): Long =
        if (previous < 0 || current < 0 || current < previous) 0 else current - previous

    /**
     * /proc, because Thread.activeCount() only counts the current thread group
     * and a thread leak is rarely polite enough to stay in it.
     */
    private fun threadCount(): Int = runCatching {
        File("/proc/self/status").useLines { lines ->
            lines.firstOrNull { it.startsWith("Threads:") }
                ?.substringAfter(':')
                ?.trim()
                ?.toInt()
                ?: -1
        }
    }.getOrDefault(-1)

    private fun mb(bytes: Long): Int = (bytes / (1024 * 1024)).toInt()

    private companion object {
        const val SAMPLE_MS = 1000L

        /** Every fifth sample takes the expensive reading. */
        const val PSS_EVERY = 5
    }
}
