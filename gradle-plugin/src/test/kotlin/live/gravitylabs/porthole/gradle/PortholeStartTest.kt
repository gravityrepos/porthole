// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.gradle.api.GradleException
import org.gradle.api.Task
import org.gradle.testfixtures.ProjectBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * [resolveInstallTask]: unambiguous auto-selects, ambiguous requires
 * `-Pporthole.variant`, and a request is always checked against the real
 * candidates rather than trusted or silently ignored.
 */
class ResolveInstallTaskTest {

    @Test
    fun `auto-selects the only debug variant`() {
        assertEquals("installDebug", resolveInstallTask(listOf("debug"), requestedVariant = null))
    }

    @Test
    fun `single flavor is still unambiguous`() {
        assertEquals("installRoomDebug", resolveInstallTask(listOf("roomDebug"), requestedVariant = null))
    }

    @Test
    fun `an explicit request is honoured even when unambiguous`() {
        assertEquals("installRoomDebug", resolveInstallTask(listOf("roomDebug"), requestedVariant = "roomDebug"))
    }

    @Test
    fun `an explicit request that names the wrong single variant is refused, not ignored`() {
        // Regression case: picking the one real candidate instead of honouring
        // the request would silently run the wrong variant on a typo.
        val error = assertThrows { resolveInstallTask(listOf("roomDebug"), requestedVariant = "sqldelightDebug") }
        assertTrue(error.message.orEmpty(), error.message!!.contains("sqldelightDebug"))
        assertTrue(error.message.orEmpty(), error.message!!.contains("roomDebug"))
    }

    /**
     * The sample app's exact shape: two flavors under one `storage`
     * dimension, both with a debug build type. GRA-174 names this scenario
     * directly as the case that must ask rather than guess.
     */
    @Test
    fun `two debug variants with no request is refused, naming both candidates`() {
        val error = assertThrows {
            resolveInstallTask(listOf("roomDebug", "sqldelightDebug"), requestedVariant = null)
        }
        assertTrue(error.message.orEmpty(), error.message!!.contains("roomDebug"))
        assertTrue(error.message.orEmpty(), error.message!!.contains("sqldelightDebug"))
        assertTrue(
            "should tell the user which property to pass:\n${error.message}",
            error.message!!.contains("porthole.variant"),
        )
    }

    @Test
    fun `two debug variants with a matching request resolves to that variant`() {
        assertEquals(
            "installSqldelightDebug",
            resolveInstallTask(listOf("roomDebug", "sqldelightDebug"), requestedVariant = "sqldelightDebug"),
        )
    }

    @Test
    fun `two debug variants with a non-matching request is refused, not defaulted`() {
        val error = assertThrows {
            resolveInstallTask(listOf("roomDebug", "sqldelightDebug"), requestedVariant = "typo")
        }
        assertTrue(error.message.orEmpty(), error.message!!.contains("typo"))
    }

    @Test
    fun `no debug variants at all is refused rather than depending on nothing`() {
        // Missing-input case: an empty list must fail loudly, not silently
        // produce a start task with a broken dependency.
        val error = assertThrows { resolveInstallTask(emptyList(), requestedVariant = null) }
        assertTrue(error.message.orEmpty(), error.message!!.contains("debugBuildTypes"))
    }

    @Test
    fun `duplicate variant names collapse rather than counting as ambiguous`() {
        assertEquals("installDebug", resolveInstallTask(listOf("debug", "debug"), requestedVariant = null))
    }

    private fun assertThrows(block: () -> Unit): GradleException {
        try {
            block()
        } catch (e: GradleException) {
            return e
        }
        fail("expected a GradleException")
        error("unreachable")
    }
}

/**
 * [portholeStartDependencies]: the literal answer to GRA-174's acceptance
 * criterion 2. Exact list equality both directions — nothing missing, nothing
 * extra — because "the parent depends on the narrow tasks" is only true if
 * this set can never silently grow a fifth entry that re-implements one of
 * them, which is exactly the failure mode the ticket calls out.
 */
class PortholeStartDependenciesTest {

    @Test
    fun `opening the browser depends on portholeUi, not portholeConnect`() {
        assertEquals(
            listOf("installDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
            portholeStartDependencies(listOf("debug"), requestedVariant = null, openUi = true),
        )
    }

    @Test
    fun `skipping the browser depends on portholeConnect, not portholeUi`() {
        // portholeUi's own CLI forwards the port itself (mcp/src/cli.ts); depending
        // on both here would forward twice, which GRA-174 explicitly forbids.
        assertEquals(
            listOf("installDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeConnect"),
            portholeStartDependencies(listOf("debug"), requestedVariant = null, openUi = false),
        )
    }

    @Test
    fun `never depends on both portholeUi and portholeConnect`() {
        val open = portholeStartDependencies(listOf("debug"), null, openUi = true).toSet()
        val closed = portholeStartDependencies(listOf("debug"), null, openUi = false).toSet()
        assertFalse(open.containsAll(setOf("portholeUi", "portholeConnect")))
        assertFalse(closed.containsAll(setOf("portholeUi", "portholeConnect")))
    }

    @Test
    fun `picks the requested variant's install task among several`() {
        assertEquals(
            listOf("installSqldelightDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
            portholeStartDependencies(listOf("roomDebug", "sqldelightDebug"), "sqldelightDebug", openUi = true),
        )
    }
}

/**
 * [registerPortholeStart] on a real (if lightweight) Gradle project, built
 * with [ProjectBuilder] rather than a full Android module — the point of this
 * test is the *wiring*, not AGP, so fake stand-ins for the narrow tasks are
 * registered by hand, the same trick [StubAdbFunctionalTest] uses for
 * `portholeConnect`/`portholeDisconnect`.
 *
 * This is the test that would not catch a bug in [portholeStartDependencies]
 * itself (that is [PortholeStartDependenciesTest]'s job) but would catch the
 * other class of bug: `registerPortholeStart` computing the right list and
 * then never actually calling `dependsOn` with it, or wiring the arguments
 * in the wrong order.
 */
class RegisterPortholeStartFunctionalTest {

    private fun newProject(narrowTasks: List<String>): org.gradle.api.Project {
        val project = ProjectBuilder.builder().build()
        narrowTasks.forEach { name -> project.tasks.register(name) }
        return project
    }

    private fun dependencyNames(task: Task): Set<String> =
        task.taskDependencies.getDependencies(task).map { it.name }.toSet()

    @Test
    fun `depends on exactly the narrow tasks for the unambiguous case`() {
        // All five narrow tasks are always registered in production
        // (registerTasks does not gate any of them on openUi), so the fixture
        // mirrors that even though this scenario only expects portholeStart to
        // depend on four of them.
        val project = newProject(
            listOf("installDebug", "portholeConnect", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
        )

        val start = registerPortholeStart(
            project = project,
            variants = project.provider { listOf("debug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { true },
        )

        assertEquals(
            setOf("installDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
            dependencyNames(start.get()),
        )
    }

    @Test
    fun `switches to portholeConnect and drops portholeUi when told not to open the browser`() {
        val project = newProject(
            listOf("installDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi", "portholeConnect"),
        )

        val start = registerPortholeStart(
            project = project,
            variants = project.provider { listOf("debug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { false },
        )

        val dependencies = dependencyNames(start.get())
        assertEquals(setOf("installDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeConnect"), dependencies)
        assertFalse("must not also depend on portholeUi", dependencies.contains("portholeUi"))
    }

    @Test
    fun `resolving dependencies on an ambiguous module fails with the candidates named`() {
        val project = newProject(
            listOf(
                "installRoomDebug",
                "installSqldelightDebug",
                "portholeConnect",
                "portholeMcpConfig",
                "portholeTraceProcessor",
                "portholeUi",
            ),
        )

        val start = registerPortholeStart(
            project = project,
            variants = project.provider { listOf("roomDebug", "sqldelightDebug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { true },
        )

        // The dependency set is computed lazily (see registerPortholeStart's
        // KDoc), so the ambiguity only surfaces when something resolves it —
        // exactly as it would when Gradle builds the real task graph.
        val error: Throwable? = try {
            dependencyNames(start.get())
            null
        } catch (e: Exception) {
            e
        }
        assertTrue("expected resolving the dependency graph to fail", error != null)
        val message = generateSequence(error) { it.cause }.mapNotNull { it.message }.joinToString(" | ")
        assertTrue(message, message.contains("roomDebug"))
        assertTrue(message, message.contains("sqldelightDebug"))
    }

    @Test
    fun `an explicit variant property resolves the ambiguous case`() {
        val project = newProject(
            listOf(
                "installRoomDebug",
                "installSqldelightDebug",
                "portholeConnect",
                "portholeMcpConfig",
                "portholeTraceProcessor",
                "portholeUi",
            ),
        )

        val start = registerPortholeStart(
            project = project,
            variants = project.provider { listOf("roomDebug", "sqldelightDebug") },
            // A plain provider standing in for `-Pporthole.variant=roomDebug`:
            // the plumbing that turns the real Gradle property into a
            // Provider<String> is PortholePlugin.registerTasks's concern, one
            // line, not this function's; what this test needs to prove is
            // that registerPortholeStart honours whatever it is handed.
            requestedVariant = project.provider { "roomDebug" },
            openUi = project.provider { false },
        )

        assertEquals(
            setOf("installRoomDebug", "portholeMcpConfig", "portholeTraceProcessor", "portholeConnect"),
            dependencyNames(start.get()),
        )
    }

    /**
     * QA on this ticket: the graph test above guards the *edges*
     * (`dependsOn`) but not the *node* — nothing stopped real work from
     * moving into `portholeStart`'s own `@TaskAction` while the dependency
     * list stayed untouched, which is exactly the re-implementation AC2 is
     * meant to rule out. Move work inline and the dependency-set tests above
     * would still pass; this is the one that would not.
     */
    @Test
    fun `portholeStart is a pure lifecycle task, with no actions of its own`() {
        val project = newProject(
            listOf("installDebug", "portholeConnect", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
        )

        val start = registerPortholeStart(
            project = project,
            variants = project.provider { listOf("debug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { true },
        )

        assertTrue("portholeStart must have no actions of its own", start.get().actions.isEmpty())
    }
}

/**
 * [registerPortholeStart]'s `mustRunAfter` wiring.
 *
 * QA on this ticket showed that `dependsOn` alone only says *that* four tasks
 * run, not in what order: an unordered set is scheduled however Gradle likes,
 * which tie-breaks alphabetically and happened to put `portholeUi` last by
 * accident. That is dangerous specifically because `portholeUi` blocks until
 * the person watching it stops it — if the tie-break ever landed differently,
 * anything after it would simply never run, and a new user's first
 * experience would be a hang.
 *
 * This asserts the real Gradle `mustRunAfter` `TaskDependency` on each narrow
 * task (the same API [RegisterPortholeStartFunctionalTest] uses for
 * `dependsOn`), which is what turns the order into a Gradle-enforced fact —
 * independent of task names — rather than a naming coincidence.
 */
class PortholeStartOrderingTest {

    private fun newProject(narrowTasks: List<String>): org.gradle.api.Project {
        val project = ProjectBuilder.builder().build()
        narrowTasks.forEach { name -> project.tasks.register(name) }
        return project
    }

    private fun mustRunAfterNames(project: org.gradle.api.Project, taskName: String): Set<String> {
        val task = project.tasks.getByName(taskName)
        return task.mustRunAfter.getDependencies(task).map { it.name }.toSet()
    }

    @Test
    fun `orders install, connect, mcp config, trace processor and ui as a real chain`() {
        val project = newProject(
            listOf("installDebug", "portholeConnect", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
        )

        registerPortholeStart(
            project = project,
            variants = project.provider { listOf("debug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { true },
        )

        assertEquals(setOf("installDebug"), mustRunAfterNames(project, "portholeConnect"))
        assertEquals(setOf("installDebug", "portholeConnect"), mustRunAfterNames(project, "portholeMcpConfig"))
        assertEquals(
            setOf("installDebug", "portholeConnect", "portholeMcpConfig"),
            mustRunAfterNames(project, "portholeTraceProcessor"),
        )
        assertEquals(
            setOf("installDebug", "portholeConnect", "portholeMcpConfig", "portholeTraceProcessor"),
            mustRunAfterNames(project, "portholeUi"),
        )
    }

    @Test
    fun `an ambiguous or absent variant orders around no install task, rather than failing`() {
        // installTaskForOrdering must never throw: a standalone run of, say,
        // ./gradlew portholeMcpConfig on an ambiguous module has nothing to
        // do with portholeStart and must keep working exactly as before
        // (AC3) -- it must not start failing just because portholeStart's
        // ordering wiring was also registered on this project.
        val project = newProject(
            listOf("portholeConnect", "portholeMcpConfig", "portholeTraceProcessor", "portholeUi"),
        )

        registerPortholeStart(
            project = project,
            variants = project.provider { listOf("roomDebug", "sqldelightDebug") },
            requestedVariant = project.providers.gradleProperty("porthole.variant"),
            openUi = project.provider { true },
        )

        assertEquals(emptySet<String>(), mustRunAfterNames(project, "portholeConnect"))
        assertEquals(setOf("portholeConnect"), mustRunAfterNames(project, "portholeMcpConfig"))
    }
}
