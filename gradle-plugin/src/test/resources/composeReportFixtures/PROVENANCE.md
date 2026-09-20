# Provenance

Real Compose compiler metrics output — not hand-written (GRA-111's rule: a self-written
fixture tests the format assumed, not the one the compiler actually emits). Captured from
this repo's own sample app, `:sample`, `roomDebug` variant, in two passes — the original
GRA-69 capture, and a QA follow-up pass that added three throwaway composables (`QaNoArgs`,
`QaDefaultInt`, `QaDefaultClass`) purely to capture two real-compiler shapes the original
capture never happened to contain (see "The QA follow-up pass" below) — and this file
describes both.

## How the original capture was produced

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

## The QA follow-up pass (D2, D3)

QA on the merged ticket found two parser bugs neither of the original file's own composables
happened to exercise: a zero-parameter composable is emitted whole on one line
(`restartable skippable fun QaNoArgs()`, no separate parameter block or closing line at all)
and was silently dropped by the header regex (D3); a parameter with a default value renders
as `count: Int = @static 1`, and the default expression was leaking into the captured *type*
(D2). Three throwaway composables were added to `sample/src/main/kotlin/com/example/shop/ui/`
for one capture only, to produce real examples of both — `QaNoArgs()` (D3), and
`QaDefaultInt(count: Int = 1, modifier: Modifier = Modifier)` /
`QaDefaultClass(holder: QaDefaultHolder? = null)` (D2, the default-typed-class shape as well
as the primitive one) — captured the same way as the original pass (`--rerun-tasks` against
the temporary DSL block above), copied into these same two files, and the throwaway source
removed again afterward. `sample/src/main/kotlin/com/example/shop/ui/` itself carries no trace
of this pass; only these two fixture files do.

## What's deliberately in these two files

- `QaNoArgs` — `restartable skippable fun QaNoArgs()`, whole on one line, zero parameters:
  D3's own fixture.
- `QaDefaultInt`, `QaDefaultClass` — D2's own fixture: `count: Int = @static 1`,
  `modifier: Modifier? = @static Companion` (the compiler's own static-value printer renders
  the `Modifier` default as `Companion`, its singleton), `holder: QaDefaultHolder? = @static
  null`. `ComposeReportParser`'s job is to capture `Int`/`Modifier?`/`QaDefaultHolder?`, never
  the ` = ...` half.
- `QaDefaultHolder` (`classes.txt`) — `unstable class QaDefaultHolder { stable var count: Int
  ... }`: the same "stable-typed var still makes the class unstable" shape `RowHighlight`
  already demonstrates, included here only because `QaDefaultClass` needed an unstable class
  to take as its own default-valued parameter.
- `LeakyRow` (`sample/src/main/kotlin/com/example/shop/ui/Screens.kt`) — GRA-69's fixture for
  "restartable but not skippable": `restartable ... fun LeakyRow(` with no `skippable` on the
  line, and its fourth parameter `unstable highlight: RowHighlight`.
- `RowHighlight` (same file) — `unstable class RowHighlight { stable var tappedAt: Long ...
  <runtime stability> = Unstable }`: a `var` property on an otherwise-stable-typed field is
  what the class-level `unstable` verdict is attributed to; this is the shape
  `ComposeReportParser`'s "has a var property" reasoning is written against.
- `CartViewModel` — unstable for *two* reasons at once, on purpose (QA B2's own fixture): five
  `stable var *$delegate: MutableState<...>` properties (`by mutableStateOf(...)`, which the
  compiler does not count against stability — mutating through them goes through Compose's own
  snapshot system) that must never be picked as "the" cause, `runtime val dao: CartStore` (an
  interface — genuinely undetermined, not proven unstable), and `unstable val api: CartApi`
  (proven unstable), which is the one `mcp/composeReport.ts`'s fixed `stabilityReason` is
  supposed to name.
- `CartApi`, `KtorApi`, `SyncCartWorker`, `ShopApplication` — real, pre-existing unstable
  classes in the sample, unstable for the same "other" reason as `CartViewModel`'s `api` field:
  an unstable-typed `val` field (`OkHttpClient`, `MockWebServer`, `HttpClient`, a `StateFlow`),
  never a `var`.
- `CartItem`, `CartItemRow`, `MainActivity`, `CartDatabase` — real stable classes, for the
  parser's stable path.
- `HomeScreen`, `ScopedRow`, `RowBody` — real `restartable skippable` composables, none of
  whose parameters are unstable, for the parser's ordinary path.
- `CartScreen`, `Controls` — **not** `skippable` either, alongside `LeakyRow`: both take
  `viewModel: CartViewModel` directly, itself unstable, and with strong skipping off (this
  whole capture's point) that alone is enough to make a composable non-skippable. `LeakyRow` is
  GRA-69's own worked example only because it also names *why* (`highlight: RowHighlight`, an
  app-owned unstable type with a var) in a way `CartScreen`/`Controls` (whose own unstable
  parameter, `CartViewModel`, is a *class* GRA-69's D7 fix calls "owned" too, just one hop
  further from the sample's central demo) do not headline.
