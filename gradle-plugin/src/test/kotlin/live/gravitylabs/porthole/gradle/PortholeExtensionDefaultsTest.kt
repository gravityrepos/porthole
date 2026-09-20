// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.testfixtures.ProjectBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The defaults are documented in the extension's own KDoc and in the README, so
 * they are part of the plugin's contract rather than an implementation detail.
 */
class PortholeExtensionDefaultsTest {

    private fun extension(): PortholeExtension {
        val project = ProjectBuilder.builder().build()
        project.plugins.apply("live.gravitylabs.porthole")
        return project.extensions.getByType(PortholeExtension::class.java)
    }

    @Test
    fun `creates the porthole extension`() {
        val project = ProjectBuilder.builder().build()
        assertNull("nothing should exist before apply", project.extensions.findByName("porthole"))

        project.plugins.apply("live.gravitylabs.porthole")
        assertTrue(project.extensions.findByName("porthole") is PortholeExtension)
    }

    @Test
    fun `defaults the port to the one the UI and MCP server look for`() {
        assertEquals(8677, extension().port.get())
    }

    @Test
    fun `defaults the ring capacity to roughly a minute of a busy screen`() {
        assertEquals(2048, extension().ringCapacity.get())
    }

    @Test
    fun `defaults to instrumenting only the debug build type`() {
        assertEquals(listOf("debug"), extension().debugBuildTypes.get())
    }

    @Test
    fun `is enabled unless a build turns it off`() {
        assertTrue(extension().enabled.get())
    }

    @Test
    fun `depends on published artifacts rather than local projects`() {
        // useProjectDependencies is for developing porthole itself. A consuming
        // build that got this wrong would fail on a missing :runtime project.
        assertFalse(extension().useProjectDependencies.get())
    }

    @Test
    fun `pins the runtime version to the plugin's own`() {
        assertEquals(PortholePlugin.PLUGIN_VERSION, extension().runtimeVersion.get())
    }

    @Test
    fun `leaves the ui command empty so npx is used`() {
        assertEquals(emptyList<String>(), extension().uiCommand.get())
    }

    @Test
    fun `leaves the device serial unset for the single-device case`() {
        assertFalse(extension().deviceSerial.isPresent)
    }

    @Test
    fun `defaults strictMode to off (GRA-59) - StrictMode has no public API to detect or chain an existing policy`() {
        assertFalse(extension().strictMode.get())
    }

    @Test
    fun `lets a build override every default`() {
        val project = ProjectBuilder.builder().build()
        project.plugins.apply("live.gravitylabs.porthole")
        val porthole = project.extensions.getByType(PortholeExtension::class.java)

        porthole.port.set(9000)
        porthole.ringCapacity.set(8192)
        porthole.debugBuildTypes.set(listOf("debug", "staging"))
        porthole.deviceSerial.set("emulator-5554")
        porthole.strictMode.set(true)

        assertEquals(9000, porthole.port.get())
        assertEquals(8192, porthole.ringCapacity.get())
        assertEquals(listOf("debug", "staging"), porthole.debugBuildTypes.get())
        assertEquals("emulator-5554", porthole.deviceSerial.get())
        assertTrue(porthole.strictMode.get())
    }
}
