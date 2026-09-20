// Fixture for GRA-201's sources.test.ts -- not part of a buildable module.
package com.example.network

class ApiClient(
    private val baseUrl: String,
) {
    fun fetchCart(id: String): String {
        return "$baseUrl/cart/$id"
    }
}
