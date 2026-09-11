# The state collector reflects over ViewModel fields to name snapshot state.
# Debug builds are not usually minified, but if yours is, keep the names.
-keepclassmembers class * extends androidx.lifecycle.ViewModel {
    <fields>;
}
-keep class live.gravitylabs.porthole.** { *; }
