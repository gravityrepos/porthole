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
                    LeakyRow(
                        item,
                        tick = viewModel.tick,
                        onBump = {
                            lastTapped = item
                            viewModel.bumpQuantity(item)
                        },
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

@Composable
private fun LeakyRow(item: CartItem, tick: Int, onBump: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().portholeNode("Cart.ItemRow")) {
        RowBody(item, tick, onBump)
    }
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
private fun RowBody(item: CartItem, tick: Int, onBump: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("${item.name} x${item.qty}")
        Text(pulse(tick))
        Button(onClick = onBump) { Text("+") }
    }
}

private fun pulse(tick: Int): String {
    val cents = 1800 + (tick % 60)
    return "£" + (cents / 100) + "." + (cents % 100).toString().padStart(2, '0')
}
