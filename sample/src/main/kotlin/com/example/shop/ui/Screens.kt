// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.example.shop.data.SyncCartWorker
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.shop.LeakFixture
import com.example.shop.data.CartItem
import live.gravitylabs.porthole.compose.PortholeScreen
import live.gravitylabs.porthole.compose.collectAsNamedState
import live.gravitylabs.porthole.compose.portholeNode

@Composable
fun HomeScreen(onOpenCart: (String) -> Unit) = PortholeScreen("Home") {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Porthole Sample", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Open the cart, then ask the porthole what this screen is doing.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Button(onClick = { onOpenCart("88213") }) { Text("Open cart 88213") }
        Text(
            "Deep link: adb shell am start -a android.intent.action.VIEW " +
                "-d \"porthole://cart/99001\"",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
fun CartScreen(viewModel: CartViewModel) = PortholeScreen("Cart") {
    // collectAsNamedState, not collectAsState: this is what lets the
    // recomposition report say "CartViewModel.items" instead of <unnamed:...>.
    val items by viewModel.items.collectAsNamedState("CartViewModel.items")
    val status by viewModel.statusFlow.collectAsNamedState("CartViewModel.status")

    // Deliberately NOT watched, to give the ownership hint something real to
    // catch: it holds a CartItem, which is one of the app's own types, so the
    // porthole can say this anonymous state is the app's and unregistered.
    var lastTapped by remember { mutableStateOf<CartItem?>(null) }

    // GRA-69: deliberately unstable — see RowHighlight's own KDoc below. One
    // instance, shared across every row, so LeakyRow keeps taking it as a
    // parameter on every recomposition rather than only the tapped row.
    val rowHighlight = remember { RowHighlight() }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Cart ${items.size} items - $status", style = MaterialTheme.typography.titleMedium)

        Controls(viewModel)

        OutlinedTextField(
            value = viewModel.promoCode,
            onValueChange = viewModel::setPromo,
            label = { Text("Promo code") },
            modifier = Modifier.fillMaxWidth().portholeNode("Cart.PromoField"),
        )

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(items, key = { it.id }) { item ->
                if (viewModel.scopedReads) {
                    // The fix: the row takes a lambda, so reading the ticking
                    // state happens inside the Text and the row does not
                    // invalidate. Same output, a fraction of the work.
                    ScopedRow(item, tick = { viewModel.tick }, onBump = { viewModel.bumpQuantity(item) })
                } else {
                    // The bug: the row reads `tick` directly, so every row
                    // recomposes on every frame while the animation runs.
                    // GRA-69: also the fixture for `portholeComposeReport` —
                    // `highlight` is RowHighlight, an unstable type, so this
                    // is the composable a stale/fresh report should call out
                    // as restartable-but-not-skippable.
                    LeakyRow(
                        item,
                        tick = viewModel.tick,
                        onBump = {
                            lastTapped = item
                            rowHighlight.tappedAt = System.currentTimeMillis()
                            viewModel.bumpQuantity(item)
                        },
                        highlight = rowHighlight,
                    )
                }
            }
        }

        Text(
            "last tapped: " + (lastTapped?.name ?: "nothing"),
            style = MaterialTheme.typography.bodySmall,
        )

        Text(
            viewModel.lastResponse.take(180),
            style = MaterialTheme.typography.bodySmall,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.portholeNode("Cart.ResponseText"),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Controls(viewModel: CartViewModel) {
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // A flow row, so adding a button never pushes one off the screen edge.
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Button(onClick = { viewModel.addRandomItem() }) { Text("Add") }
            Button(onClick = { viewModel.refresh() }) { Text("Refresh") }
            Button(onClick = { viewModel.checkout() }) { Text("Checkout") }
            Button(onClick = { viewModel.uploadNote() }) { Text("Upload note") }
            Button(onClick = { viewModel.fetchThumbnail() }) { Text("Thumbnail") }
            Button(onClick = { viewModel.blockTheMainThread() }) { Text("Block main") }
            Button(onClick = { viewModel.triggerStrictModeViolation(context) }) { Text("StrictMode") }
            // GRA-64: a deliberate, obvious fixture — see LeakFixture's own
            // doc comment for what to do after pressing it.
            Button(onClick = { LeakFixture.leak(context) }) { Text("Leak activity") }
            Button(onClick = { viewModel.fetchWithKtor() }) { Text("Ktor") }
            Button(onClick = {
                WorkManager.getInstance(context)
                    .enqueue(OneTimeWorkRequestBuilder<SyncCartWorker>().build())
            }) { Text("Sync") }
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = viewModel.animating, onCheckedChange = { viewModel.toggleAnimation() })
                Text("Animate totals")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = viewModel.scopedReads, onCheckedChange = { viewModel.toggleScopedReads() })
                Text("Scoped reads")
            }
        }
    }
}

/**
 * GRA-69: deliberately unstable — a `var` property gives the Compose
 * compiler no equality it can trust, so any composable that takes one as a
 * parameter cannot be proven skippable no matter how rarely it actually
 * changes. This is the sample's fixture for `portholeComposeReport`: with
 * strong skipping off (see that task's own KDoc for why the report forces
 * it off), [LeakyRow] reports as restartable but not skippable because of
 * this parameter, and this class reports unstable because it has a `var`.
 * The out-of-scope fix (per GRA-69's own ticket) would be `@Immutable`, or
 * splitting the mutable field out into a `MutableState` the compiler can
 * see — neither is applied here on purpose.
 */
class RowHighlight(var tappedAt: Long = 0L)

@Composable
private fun LeakyRow(item: CartItem, tick: Int, onBump: () -> Unit, highlight: RowHighlight) {
    Card(modifier = Modifier.fillMaxWidth().portholeNode("Cart.ItemRow")) {
        RowBody(item, tick, onBump, highlight)
    }
}

/**
 * GRA-69 QA (AC3): a dedicated child, not folded into [RowBody] directly,
 * because [RowBody] itself already reads `tick` unscoped (the *other*,
 * pre-existing bug this sample demonstrates — see the README's "Animate
 * totals" walkthrough) and so recomposes 60 times a second for a reason
 * that has nothing to do with `highlight` at all. Measuring `Cart.ItemRow`'s
 * own count to prove GRA-69's join would be measuring `tick`'s effect, not
 * `highlight`'s — exactly the flaw QA's own AC3 caught (the count barely
 * moved, in either direction, after stabilising `RowHighlight`, because it
 * was never what was driving it).
 *
 * `Cart.ItemHighlight` is the isolated fixture instead: its *only*
 * parameter is `highlight`, the same single, `remember`ed instance on every
 * one of `RowBody`'s own 60fps recompositions (never a fresh object — only
 * its `var` field mutates, and only on a tap). A skippable composable would
 * skip almost every one of those calls, since the one parameter it has
 * never actually changes identity; `highlight`'s own instability is what
 * makes that skip impossible. Stabilising [RowHighlight] is therefore the
 * one change that drops this composable's own recomposition count to
 * (near) zero, independent of `tick`, with nothing about the event stream
 * itself different — the fixture-driven proof `trace.test.ts` pins, and
 * the live one this ticket's QA pass closed by hand against an emulator.
 */
@Composable
private fun HighlightBadge(highlight: RowHighlight) {
    val recentlyTapped = System.currentTimeMillis() - highlight.tappedAt < 500
    Text(if (recentlyTapped) "• " else "", modifier = Modifier.portholeNode("Cart.ItemHighlight"))
}

@Composable
private fun ScopedRow(item: CartItem, tick: () -> Int, onBump: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().portholeNode("Cart.ItemRowScoped")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("${item.name} x${item.qty}")
            // The read happens here and nowhere above, so only this Text
            // recomposes when the tick changes.
            Text(pulse(tick()), modifier = Modifier.portholeNode("Cart.TotalPulse"))
            Button(onClick = onBump) { Text("+") }
        }
    }
}

@Composable
private fun RowBody(item: CartItem, tick: Int, onBump: () -> Unit, highlight: RowHighlight) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HighlightBadge(highlight)
        Text("${item.name} x${item.qty}")
        Text(pulse(tick))
        Button(onClick = onBump) { Text("+") }
    }
}

private fun pulse(tick: Int): String {
    val cents = 1800 + (tick % 60)
    return "£" + (cents / 100) + "." + (cents % 100).toString().padStart(2, '0')
}
