// Fixture for GRA-201's sources.test.ts -- not part of a buildable module.
// Same basename as core/network's Repository.kt, deliberately, in a
// different package -- the GRA-201 follow-up's own fixture for
// package-based disambiguation: a stack frame naming one package must
// resolve to this file, not the other.
package com.example.shop.data

class Repository {
    fun fetch(id: String): String = id
}
