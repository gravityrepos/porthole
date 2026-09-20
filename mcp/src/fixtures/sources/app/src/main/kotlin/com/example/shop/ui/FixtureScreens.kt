// Fixture for GRA-201's sources.test.ts -- not part of a buildable module.
// "Fixture.PromoField", not "Cart.PromoField" -- see FixtureCartViewModel.kt's
// own comment; the sample app uses the latter label for real.
package com.example.shop.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import live.gravitylabs.porthole.compose.PortholeScreen
import live.gravitylabs.porthole.compose.portholeNode

@Composable
fun FixtureCartScreen() = PortholeScreen("FixtureCart") {
    Box(modifier = Modifier.portholeNode("Fixture.PromoField"))
}
