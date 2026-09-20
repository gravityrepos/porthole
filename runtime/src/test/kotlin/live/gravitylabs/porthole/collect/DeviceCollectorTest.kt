// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.Application
import android.content.pm.PackageInfo
import android.os.Bundle
import android.os.PowerManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import live.gravitylabs.porthole.protocol.EventFrame
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager
import java.io.File

/**
 * GRA-73: thermal transitions, per-Activity onCreate/onDestroy (rotation
 * vs process restore), and the permission grant set — all wired through
 * [DeviceCollector]'s own existing [Application.ActivityLifecycleCallbacks]
 * registration rather than a second, competing one (see [watchLifecycle]'s
 * own comment).
 *
 * The "isChangingConfigurations flips to true across a real rotation" half
 * of the rotation/restore acceptance criterion is not testable here at
 * all: Robolectric's `isChangingConfigurations` is unconditionally `false`
 * regardless of `recreate()`/`configurationChange()` (a known Robolectric
 * limitation — robolectric/robolectric#7972), so a Robolectric-driven
 * "rotation" would only ever prove this class reads that flag, not that a
 * real rotation sets it. Which is exactly the split the ticket's own
 * acceptance criteria already draw: "emulator: rotate ... Robolectric
 * ActivityController for that" names the *process-restore* half as
 * Robolectric's job (a fresh `onCreate(savedInstanceState)` with no prior
 * `onDestroy` in this session, `isChangingConfigurations() == false` —
 * true both for a real restore and, incidentally, for every Robolectric
 * activity) and leaves the rotation half to a real device.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class DeviceCollectorTest {

    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun deviceEvents(ring: EventRing, kind: String): List<EventFrame> =
        ring.since(0, 10_000).filter { it.event == EventKinds.DEVICE }
            .filter { (it.data as JsonObject).getValue("kind").jsonPrimitive.content == kind }

    private fun EventFrame.field(key: String) = (data as JsonObject).getValue(key).jsonPrimitive

    // -- thermal (API 29+, Robolectric's ShadowPowerManager supports it) -----

    @Test
    fun `a thermal status transition is emitted with the status name and code`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        val power = app.getSystemService(Application.POWER_SERVICE) as PowerManager
        Shadows.shadowOf(power).setCurrentThermalStatus(PowerManager.THERMAL_STATUS_SEVERE)

        val thermal = deviceEvents(ring, "thermal")
        assertEquals(1, thermal.size)
        assertEquals("severe", thermal[0].field("status").content)
        assertEquals(PowerManager.THERMAL_STATUS_SEVERE.toString(), thermal[0].field("statusCode").content)
    }

    @Test
    fun `every named thermal status renders as a lowercase word, not a raw int`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)
        val power = Shadows.shadowOf(app.getSystemService(Application.POWER_SERVICE) as PowerManager)

        val expected = mapOf(
            PowerManager.THERMAL_STATUS_NONE to "none",
            PowerManager.THERMAL_STATUS_LIGHT to "light",
            PowerManager.THERMAL_STATUS_MODERATE to "moderate",
            PowerManager.THERMAL_STATUS_SEVERE to "severe",
            PowerManager.THERMAL_STATUS_CRITICAL to "critical",
            PowerManager.THERMAL_STATUS_EMERGENCY to "emergency",
            PowerManager.THERMAL_STATUS_SHUTDOWN to "shutdown",
        )
        for ((code, name) in expected) power.setCurrentThermalStatus(code)

        val names = deviceEvents(ring, "thermal").map { it.field("status").content }
        assertEquals(expected.values.toList(), names)
    }

    @Test
    fun `stop unregisters the thermal listener, so a later transition emits nothing more`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)
        val power = Shadows.shadowOf(app.getSystemService(Application.POWER_SERVICE) as PowerManager)

        power.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_LIGHT)
        collector.stop(app)
        power.setCurrentThermalStatus(PowerManager.THERMAL_STATUS_SEVERE)

        assertEquals(1, deviceEvents(ring, "thermal").size)
    }

    // -- no polling: a callback, never a scheduled re-check -------------------

    @Test
    fun `the collector's own source never schedules a delayed re-check for anything this ticket added`() {
        // GRA-73 AC: "no polling" — asserted structurally, the same way
        // ApiParityTest reads source text rather than instrumenting
        // behaviour, because the property under test is the *absence* of a
        // call, which no amount of running the code can observe directly.
        val source = File("src/main/kotlin/live/gravitylabs/porthole/collect/DeviceCollector.kt").readText()
        assertFalse(
            "DeviceCollector must not poll for thermal status or permissions — both are event-driven " +
                "(a PowerManager listener, and a lifecycle-triggered check), never a Handler.postDelayed loop",
            source.contains("postDelayed"),
        )
    }

    // -- per-Activity onCreate/onDestroy: process restore ---------------------

    @Test
    fun `a fresh onCreate with a saved instance state (process restore) reports it, and isChangingConfigurations false`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        val savedState = Bundle().apply { putString("k", "v") }
        Robolectric.buildActivity(PlainDeviceActivity::class.java).create(savedState).start().resume()

        val events = deviceEvents(ring, "activityLifecycle")
        val create = events.single { it.field("phase").content == "create" }
        assertEquals("true", create.field("savedInstanceState").content)
        assertEquals(
            "a process restore is not a configuration change — Robolectric never sets this flag " +
                "either way, which happens to match a real restore's own value",
            "false",
            create.field("isChangingConfigurations").content,
        )
    }

    @Test
    fun `a fresh onCreate with no saved state reports savedInstanceState false`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        Robolectric.buildActivity(PlainDeviceActivity::class.java).create(null).start().resume()

        val create = deviceEvents(ring, "activityLifecycle").single { it.field("phase").content == "create" }
        assertEquals("false", create.field("savedInstanceState").content)
    }

    @Test
    fun `destroy is reported with the activity's own simple name`() {
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        val controller = Robolectric.buildActivity(PlainDeviceActivity::class.java)
        controller.create().start().resume().pause().stop().destroy()

        val destroy = deviceEvents(ring, "activityLifecycle").single { it.field("phase").content == "destroy" }
        assertEquals("PlainDeviceActivity", destroy.field("activity").content)
    }

    @Test
    fun `only one ActivityLifecycleCallbacks registration backs both onCreate and onDestroy reporting`() {
        // Structural proof for "exactly one registration per app": the same
        // install() that already registers foreground/background tracking
        // is what produced the activityLifecycle events above — if a
        // second, competing callbacks object existed, onCreate/onDestroy
        // would each be reported twice.
        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        Robolectric.buildActivity(PlainDeviceActivity::class.java).create(null).start().resume()

        assertEquals(1, deviceEvents(ring, "activityLifecycle").count { it.field("phase").content == "create" })
    }

    // -- permission set ---------------------------------------------------------

    @Test
    fun `the permission set is checked once at install and reports granted and denied separately`() {
        val shadowPackages = Shadows.shadowOf(app.packageManager)
        shadowPackages.installPackage(
            PackageInfo().apply {
                packageName = app.packageName
                requestedPermissions = arrayOf(
                    "android.permission.CAMERA",
                    "android.permission.RECORD_AUDIO",
                )
            },
        )
        Shadows.shadowOf(app).grantPermissions("android.permission.CAMERA")

        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)

        val installEvent = deviceEvents(ring, "permissions").single { it.field("trigger").content == "install" }
        assertEquals("android.permission.CAMERA", installEvent.field("granted").content)
        assertEquals("android.permission.RECORD_AUDIO", installEvent.field("denied").content)
    }

    @Test
    fun `a revocation while backgrounded shows up on the next foreground, not before`() {
        val shadowPackages = Shadows.shadowOf(app.packageManager)
        shadowPackages.installPackage(
            PackageInfo().apply {
                packageName = app.packageName
                requestedPermissions = arrayOf("android.permission.CAMERA")
            },
        )
        Shadows.shadowOf(app).grantPermissions("android.permission.CAMERA")

        val ring = EventRing()
        val collector = DeviceCollector(ring)
        collector.install(app)
        assertEquals(
            "android.permission.CAMERA",
            deviceEvents(ring, "permissions").single { it.field("trigger").content == "install" }
                .field("granted").content,
        )

        // The app backgrounds, the permission is revoked out from under it
        // (Settings, or this ticket's own `adb shell pm revoke` AC), and
        // only the *next* foreground transition can possibly notice.
        Shadows.shadowOf(app).denyPermissions("android.permission.CAMERA")
        Robolectric.buildActivity(PlainDeviceActivity::class.java).create(null).start().resume()

        val foregroundEvents = deviceEvents(ring, "permissions").filter { it.field("trigger").content == "foreground" }
        assertEquals(1, foregroundEvents.size)
        assertEquals("android.permission.CAMERA", foregroundEvents[0].field("denied").content)
        assertEquals("", foregroundEvents[0].field("granted").content)
    }
}

private class PlainDeviceActivity : Activity()
