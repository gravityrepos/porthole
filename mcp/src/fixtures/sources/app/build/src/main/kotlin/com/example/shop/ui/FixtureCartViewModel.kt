// Decoy: generated output under build/, which sources.ts must never walk.
// Deliberately placed under a src/ segment (build/src/main/kotlin/...) --
// a decoy outside any src/ segment would be excluded by that check alone,
// which would make this fixture prove nothing about the build/ skip
// specifically. Real Gradle output rarely nests a literal "src" this way;
// this path exists only to isolate the one thing this fixture is for.
package com.example.shop.ui

class FixtureCartViewModel
