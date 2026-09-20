# Provenance

Real Compose compiler metrics output — not hand-written (GRA-111's rule: a self-written
fixture tests the format assumed, not the one the compiler actually emits). Captured from
this repo's own sample app, `:sample`, `roomDebug` variant.

## How these were produced

The compose compiler Gradle plugin (`org.jetbrains.kotlin.plugin.compose` 2.1.0, the version
pinned in `gradle/libs.versions.toml`'s `kotlin` entry) was pointed at a scratch output
directory by temporarily adding, directly to `sample/build.gradle.kts`:

```kotlin
composeCompiler {
    reportsDestination.set(layout.buildDirectory.dir("porthole-test/reports"))
    metricsDestination.set(layout.buildDirectory.dir("porthole-test/metrics"))
    enableStrongSkippingMode.set(false)
}
```

then running, with a clean Kotlin-compile cache miss forced (`--rerun-tasks`, since neither
`reportsDestination` nor `enableStrongSkippingMode` is wired as a build-cache key input for
`compileRoomDebugKotlin` — a real footgun `PortholeComposeReportTask`'s own KDoc documents,
because it is exactly what `portholeComposeReport` has to force around on every real run):

```
./gradlew :sample:compileRoomDebugKotlin --rerun-tasks
```

`sample_roomDebug-composables.txt` and `sample_roomDebug-classes.txt` were copied out of
`sample/build/porthole-test/reports/` byte-for-byte, and the temporary DSL block and the
scratch output directory were then removed — `portholeComposeReport` (this ticket's own
task) is what sets this DSL for real, conditionally, and is exercised against these exact
files by `ComposeReportParserTest`.

`enableStrongSkippingMode.set(false)` is not incidental to the capture; it is the setting
`PortholeComposeReportTask` itself forces (see its KDoc for why: Kotlin 2.1's compose
compiler defaults strong skipping to *on*, under which a composable with an unstable
parameter is still reported `skippable` — the per-composable flag this whole ticket joins
against never fires under the default, so the report task always disables it for its own,
report-only recompile regardless of what the app's real `composeCompiler{}` block says).

## What's deliberately in these two files

- `LeakyRow` (`sample/src/main/kotlin/com/example/shop/ui/Screens.kt`) — GRA-69's fixture for
  "restartable but not skippable": `restartable ... fun LeakyRow(` with no `skippable` on the
  line, and its fourth parameter `unstable highlight: RowHighlight`.
- `RowHighlight` (same file) — `unstable class RowHighlight { stable var tappedAt: Long ...
  <runtime stability> = Unstable }`: a `var` property on an otherwise-stable-typed field is
  what the class-level `unstable` verdict is attributed to; this is the shape
  `ComposeReportParser`'s "has a var property" reasoning is written against.
- `CartViewModel`, `CartApi`, `KtorApi`, `SyncCartWorker`, `ShopApplication` — real,
  pre-existing unstable classes in the sample, unstable for the *other* reason
  (`ComposeReportParserTest` pins both): an unstable-typed `val` field (`OkHttpClient`,
  `MockWebServer`, `HttpClient`, a `StateFlow`), not a `var`.
- `CartItem`, `CartItemRow`, `MainActivity`, `CartDatabase` — real stable classes, for the
  parser's stable path.
- `HomeScreen`, `CartScreen`, `Controls`, `ScopedRow`, `RowBody` — every other real composable
  in the module, all `restartable skippable` even where a parameter (`CartViewModel`) is
  itself unstable, which is `enableStrongSkippingMode.set(false)`'s whole point: without it,
  none of these would ever report `skippable: false` and this fixture would have nothing to
  prove the parser's "not skippable" branch against.
