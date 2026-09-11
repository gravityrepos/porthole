// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package com.example.shop.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import com.example.shop.ShopApplication
import live.gravitylabs.porthole.Porthole
import live.gravitylabs.porthole.compose.PortholeRoot

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as ShopApplication

        setContent {
            MaterialTheme {
                // One wrapper at the root. Gives the semantics collector a view
                // to walk and roots the timeline.
                PortholeRoot {
                    // targetSdk 35 is edge to edge whether the app asks or not,
                    // so the surface keeps the full window and the content is
                    // inset out from under the status and navigation bars.
                    Surface(modifier = Modifier.fillMaxSize()) {
                      Box(modifier = Modifier.safeDrawingPadding()) {
                        val navController = rememberNavController()

                        DisposableEffect(navController) {
                            Porthole.registerNavController(navController)
                            onDispose { }
                        }

                        NavHost(navController = navController, startDestination = "home") {
                            composable("home") {
                                HomeScreen(onOpenCart = { navController.navigate("cart/$it") })
                            }
                            composable(
                                route = "cart/{cartId}",
                                arguments = listOf(navArgument("cartId") { type = NavType.StringType }),
                                deepLinks = listOf(navDeepLink { uriPattern = "porthole://cart/{cartId}" }),
                            ) { entry ->
                                val cartId = entry.arguments?.getString("cartId") ?: "88213"
                                val viewModel: CartViewModel = viewModel(
                                    factory = CartViewModelFactory(app, cartId),
                                )

                                // No registerViewModel call. The runtime reads
                                // the Activity's own ViewModelStore, so an
                                // activity-scoped view model names itself.
                                CartScreen(viewModel)
                            }
                        }
                      }
                    }
                }
            }
        }
    }
}

private class CartViewModelFactory(
    private val app: ShopApplication,
    private val cartId: String,
) : ViewModelProvider.Factory {

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        CartViewModel(app.store, app.api, cartId) as T
}
