// Fixture for GRA-201's sources.test.ts -- not part of a buildable module.
// Named distinctly from anything under sample/ (FixtureCartViewModel, not
// CartViewModel) so a walk rooted at the whole worktree -- which is exactly
// what sources.sample.test.ts does -- never finds this fixture and the real
// sample app's own CartViewModel.kt at once and calls the pair ambiguous.
package com.example.shop.ui

class FixtureCartViewModel(
    private val store: Any,
) {
    fun blockTheMainThread() {
        Thread.sleep(9000)
    }
}
