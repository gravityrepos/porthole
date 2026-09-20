// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.BroadcastReceiver
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.StatFs
import android.view.Surface
import android.view.WindowManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import live.gravitylabs.porthole.clockOffsets
import live.gravitylabs.porthole.protocol.DeviceEventKinds
import live.gravitylabs.porthole.protocol.EventKinds
import live.gravitylabs.porthole.store.EventRing

/**
 * What the device and the app were doing, as opposed to what the code was doing.
 *
 * An agent reading a trace has no way to know the screen rotated, the app went
 * to the background, the system asked for memory back, or the radio dropped to
 * cellular — and each of those explains a whole class of symptom that otherwise
 * looks like a bug in the app. These are cheap to observe and expensive to
 * guess at, which is a good reason to record them.
 *
 * Everything here is a callback rather than a poll. None of it fires often.
 */
internal class DeviceCollector(private val ring: EventRing) {

    private var started = 0
    private var foreground = false
    private var receiver: BroadcastReceiver? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lifecycleCallbacks: Application.ActivityLifecycleCallbacks? = null
    private var componentCallbacks: ComponentCallbacks2? = null

    /** GRA-73: null below API 29, where there is nothing to unregister on [stop]. */
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    fun install(app: Application): Boolean {
        emitProfile(app)
        watchLifecycle(app)
        watchConfiguration(app)
        watchPower(app)
        watchNetwork(app)
        watchThermal(app)
        emitPermissions(app, trigger = "install")
        return true
    }

    fun stop(app: Application) {
        receiver?.let { runCatching { app.unregisterReceiver(it) } }
        receiver = null
        networkCallback?.let { callback ->
            runCatching {
                connectivity(app)?.unregisterNetworkCallback(callback)
            }
        }
        networkCallback = null
        lifecycleCallbacks?.let { runCatching { app.unregisterActivityLifecycleCallbacks(it) } }
        lifecycleCallbacks = null
        componentCallbacks?.let { runCatching { app.unregisterComponentCallbacks(it) } }
        componentCallbacks = null
        thermalListener?.let { listener ->
            runCatching {
                (app.getSystemService(Context.POWER_SERVICE) as? PowerManager)
                    ?.removeThermalStatusListener(listener)
            }
        }
        thermalListener = null
    }

    // -- the machine it is running on ---------------------------------------

    private fun emitProfile(app: Application) {
        val activityManager = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val memory = ActivityManager.MemoryInfo().also { info ->
            runCatching { activityManager?.getMemoryInfo(info) }
        }
        val metrics = app.resources.displayMetrics
        val stat = runCatching { StatFs(app.filesDir.absolutePath) }.getOrNull()

        emit(
            DeviceEventKinds.PROFILE,
            buildMap {
                put("model", Build.MANUFACTURER + " " + Build.MODEL)
                put("sdkInt", Build.VERSION.SDK_INT.toString())
                put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                put("cores", Runtime.getRuntime().availableProcessors().toString())
                put("deviceRamMb", (memory.totalMem / (1024 * 1024)).toString())
                put("lowRamDevice", (activityManager?.isLowRamDevice == true).toString())
                put("screenDp", "${metrics.widthPixels / metrics.density.toInt().coerceAtLeast(1)}" +
                    "x${metrics.heightPixels / metrics.density.toInt().coerceAtLeast(1)}")
                put("density", metrics.density.toString())
                put("refreshHz", refreshRate(app).toString())
                stat?.let {
                    put("storageFreeMb", (it.availableBytes / (1024 * 1024)).toString())
                    put("storageTotalMb", (it.totalBytes / (1024 * 1024)).toString())
                }
                put("locale", app.resources.configuration.locales[0].toLanguageTag())
                put("fontScale", app.resources.configuration.fontScale.toString())
                put("darkMode", isDark(app.resources.configuration).toString())
                put("rotation", rotationName(rotationOf(app)))
            },
        )
        emitClocks()
    }

    /**
     * What Porthole's clock reads against the system's, so a timestamp taken
     * from somewhere else can be found in a capture.
     *
     * Perfetto stamps its events with CLOCK_BOOTTIME and Porthole uses
     * CLOCK_MONOTONIC, which differ by however long the device has been in
     * deep sleep. Emitted as an event rather than a field on the profile
     * because the gap grows every time the device sleeps: one reading at
     * startup is only true until the first doze.
     */
    fun emitClocks() {
        val clocks = clockOffsets()
        emit(
            DeviceEventKinds.CLOCKS,
            mapOf(
                "uptimeMs" to clocks.uptimeMs.toString(),
                "bootMs" to clocks.bootMs.toString(),
                "wallMs" to clocks.wallMs.toString(),
                "sleepMs" to clocks.sleepMs.toString(),
            ),
        )
    }

    private fun refreshRate(app: Application): Int = runCatching {
        val window = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        @Suppress("DEPRECATION")
        (window?.defaultDisplay?.refreshRate ?: 60f).toInt()
    }.getOrDefault(60)

    // -- foreground and background ------------------------------------------

    /**
     * Counted from started activities rather than ProcessLifecycleOwner, which
     * would put another androidx dependency in the way of an app that does not
     * already have it.
     */
    private fun watchLifecycle(app: Application) {
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                started += 1
                if (started == 1 && !foreground) {
                    foreground = true
                    emit(DeviceEventKinds.FOREGROUND, mapOf("activity" to activity.javaClass.simpleName))
                    // GRA-73: the current grant set, re-checked on every
                    // foreground transition — a permission revoked while the
                    // app was backgrounded (Settings, or `adb shell pm
                    // revoke` for this ticket's own AC) only ever shows up
                    // to the OS, and therefore to this check, the next time
                    // the app is resumed.
                    emitPermissions(app, trigger = "foreground")
                }
            }

            override fun onActivityStopped(activity: Activity) {
                started = (started - 1).coerceAtLeast(0)
                if (started == 0 && foreground) {
                    foreground = false
                    emit(DeviceEventKinds.BACKGROUND, mapOf("activity" to activity.javaClass.simpleName))
                }
            }

            // GRA-73: filled in here rather than through a second
            // registration — GRA-60's StartupCollector already registers
            // its own ActivityLifecycleCallbacks for a different reason
            // (launch timing), and this class already has one of its own
            // for foreground/background; a third competing observer would
            // double-count the same callbacks for no reason. These two were
            // the only no-ops left in this class's own lifecycle object.
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                emit(
                    DeviceEventKinds.ACTIVITY_LIFECYCLE,
                    mapOf(
                        "phase" to "create",
                        "activity" to activity.javaClass.simpleName,
                        // True for both halves of a configuration-driven
                        // recreate (a rotation, say) — false for a fresh
                        // process handed a saved instance state back
                        // (`am kill` + relaunch), which is exactly the
                        // "rotation vs process restore" distinction this
                        // event exists to carry: the same `savedInstanceState
                        // != null` is true in both cases, so it alone cannot
                        // tell them apart, but this flag can.
                        "isChangingConfigurations" to activity.isChangingConfigurations.toString(),
                        "savedInstanceState" to (state != null).toString(),
                    ),
                )
            }

            override fun onActivityDestroyed(activity: Activity) {
                emit(
                    DeviceEventKinds.ACTIVITY_LIFECYCLE,
                    mapOf(
                        "phase" to "destroy",
                        "activity" to activity.javaClass.simpleName,
                        "isChangingConfigurations" to activity.isChangingConfigurations.toString(),
                    ),
                )
            }

            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
        }
        lifecycleCallbacks = callbacks
        app.registerActivityLifecycleCallbacks(callbacks)
    }

    // -- rotation, dark mode, font scale, and memory pressure ---------------

    private fun watchConfiguration(app: Application) {
        var lastRotation = rotationOf(app)
        var lastDark = isDark(app.resources.configuration)
        var lastFontScale = app.resources.configuration.fontScale

        val callbacks = object : ComponentCallbacks2 {
            override fun onConfigurationChanged(configuration: Configuration) {
                val rotation = rotationOf(app)
                if (rotation != lastRotation) {
                    lastRotation = rotation
                    emit(
                        DeviceEventKinds.ROTATION,
                        mapOf(
                            "rotation" to rotationName(rotation),
                            "orientation" to
                                if (configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
                                    "landscape"
                                } else {
                                    "portrait"
                                },
                        ),
                    )
                }

                val dark = isDark(configuration)
                if (dark != lastDark) {
                    lastDark = dark
                    emit(DeviceEventKinds.THEME, mapOf("darkMode" to dark.toString()))
                }

                if (configuration.fontScale != lastFontScale) {
                    lastFontScale = configuration.fontScale
                    emit(DeviceEventKinds.FONT_SCALE, mapOf("fontScale" to configuration.fontScale.toString()))
                }
            }

            /**
             * The system asking for memory back, which is the most direct signal
             * there is that the app is about to be killed for using too much.
             */
            override fun onTrimMemory(level: Int) {
                emit(DeviceEventKinds.TRIM_MEMORY, mapOf("level" to trimName(level), "raw" to level.toString()))
            }

            @Deprecated("Required by ComponentCallbacks2 below API 34")
            override fun onLowMemory() {
                emit(DeviceEventKinds.LOW_MEMORY, emptyMap())
            }
        }
        componentCallbacks = callbacks
        app.registerComponentCallbacks(callbacks)
    }

    // -- battery, doze, power save ------------------------------------------

    private fun watchPower(app: Application) {
        val power = app.getSystemService(Context.POWER_SERVICE) as? PowerManager

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }

        val listener = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                emit(
                    DeviceEventKinds.POWER,
                    buildMap {
                        put("change", intent.action?.substringAfterLast('.') ?: "unknown")
                        put("batteryPercent", batteryPercent(context).toString())
                        power?.let {
                            put("dozing", it.isDeviceIdleMode.toString())
                            put("powerSaver", it.isPowerSaveMode.toString())
                        }
                    },
                )
                // A power change is the one moment the device plausibly slept,
                // which is the only thing that moves the two clocks apart.
                emitClocks()
            }
        }

        receiver = listener
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                app.registerReceiver(listener, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                app.registerReceiver(listener, filter)
            }
        }

        // The opening state, so a trace that never sees a change still says
        // whether the device was dozing the whole time.
        emit(
            DeviceEventKinds.POWER,
            buildMap {
                put("change", "initial")
                put("batteryPercent", batteryPercent(app).toString())
                power?.let {
                    put("dozing", it.isDeviceIdleMode.toString())
                    put("powerSaver", it.isPowerSaveMode.toString())
                }
            },
        )
    }

    private fun batteryPercent(context: Context): Int = runCatching {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }.getOrDefault(-1)

    // -- what the radio is doing --------------------------------------------

    private fun watchNetwork(app: Application) {
        val manager = connectivity(app) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                emit(
                    DeviceEventKinds.NETWORK,
                    mapOf(
                        "transport" to transportName(caps),
                        "metered" to
                            (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
                                .toString(),
                        "validated" to
                            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                                .toString(),
                    ),
                )
            }

            override fun onLost(network: Network) {
                emit(DeviceEventKinds.NETWORK, mapOf("transport" to "none"))
            }
        }

        networkCallback = callback
        // Needs ACCESS_NETWORK_STATE, which the debug manifest adds. An app that
        // strips it still gets everything else.
        runCatching { manager.registerDefaultNetworkCallback(callback) }
    }

    private fun connectivity(app: Application): ConnectivityManager? =
        app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    // -- thermal throttling (GRA-73) -----------------------------------------

    /**
     * `PowerManager.addThermalStatusListener` — a real callback, not a poll:
     * the system calls this exactly when the platform's own thermal status
     * classification changes, so there is nothing here to schedule on a
     * timer. API 29+; below that, this is a no-op and `thermalListener`
     * stays null, which [stop] already treats as "nothing to unregister."
     *
     * `getThermalHeadroom` (API 30+, read fresh on every transition rather
     * than cached) forecasts how close the device is to throttling further,
     * [FORECAST_SECONDS] out — the system's own recommended way to get
     * ahead of a transition rather than only ever reacting to one after it
     * already happened. Omitted below API 30, or when the platform itself
     * returns `NaN` (undocumented headroom on this device).
     */
    private fun watchThermal(app: Application) {
        if (Build.VERSION.SDK_INT < 29) return
        val power = app.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            emit(
                DeviceEventKinds.THERMAL,
                buildMap {
                    put("status", thermalStatusName(status))
                    put("statusCode", status.toString())
                    if (Build.VERSION.SDK_INT >= 30) {
                        val headroom = runCatching { power.getThermalHeadroom(FORECAST_SECONDS) }.getOrNull()
                        if (headroom != null && !headroom.isNaN()) {
                            put("thermalHeadroom", headroom.toString())
                        }
                    }
                },
            )
        }
        thermalListener = listener
        // The single-argument overload (main thread), not the Executor one:
        // the callback only ever builds a small map and emits an event, so
        // there is nothing to gain from a second thread, and Robolectric's
        // own shadow (DeviceCollectorTest) only shadows this overload —
        // the Executor one silently reaches the real, unshadowed framework
        // method under test, which is indistinguishable from "broken."
        runCatching { power.addThermalStatusListener(listener) }
            .onFailure { thermalListener = null }
    }

    private fun thermalStatusName(status: Int): String = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> "none"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        else -> "unknown($status)"
    }

    // -- permission set (GRA-73) ---------------------------------------------

    /**
     * The app's current grant set — one [Context.checkSelfPermission] pass
     * over exactly the permissions the manifest declared, read from
     * [android.content.pm.PackageManager] rather than a fixed list, so this
     * says something about *this* app rather than the platform's full
     * permission catalogue. Called once at install (the set at launch) and
     * again on every foreground transition (see [watchLifecycle]) — a
     * revocation made while the app was backgrounded (Settings, or `adb
     * shell pm revoke`) is invisible to the process until the OS hands
     * control back to it, which is exactly when this fires next.
     */
    private fun emitPermissions(app: Application, trigger: String) {
        val requested = runCatching {
            app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions
        }.getOrNull() ?: return
        if (requested.isEmpty()) return

        val granted = mutableListOf<String>()
        val denied = mutableListOf<String>()
        for (permission in requested) {
            val isGranted = runCatching {
                app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
            }.getOrDefault(false)
            (if (isGranted) granted else denied) += permission
        }

        emit(
            DeviceEventKinds.PERMISSIONS,
            mapOf(
                "trigger" to trigger,
                "granted" to granted.joinToString(","),
                "denied" to denied.joinToString(","),
            ),
        )
    }

    private fun transportName(caps: NetworkCapabilities): String = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        else -> "other"
    }

    // -- shared -------------------------------------------------------------

    private fun rotationOf(app: Application): Int = runCatching {
        val window = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        @Suppress("DEPRECATION")
        window?.defaultDisplay?.rotation ?: Surface.ROTATION_0
    }.getOrDefault(Surface.ROTATION_0)

    private fun rotationName(rotation: Int): String = when (rotation) {
        Surface.ROTATION_90 -> "90"
        Surface.ROTATION_180 -> "180"
        Surface.ROTATION_270 -> "270"
        else -> "0"
    }

    private fun isDark(configuration: Configuration): Boolean =
        configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES

    private fun trimName(level: Int): String = when (level) {
        ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "complete"
        ComponentCallbacks2.TRIM_MEMORY_MODERATE -> "moderate"
        ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> "background"
        ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "ui hidden"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "running critical"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "running low"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "running moderate"
        else -> level.toString()
    }

    private fun emit(kind: String, fields: Map<String, String>) {
        ring.emit(
            EventKinds.DEVICE,
            JsonObject(
                buildMap {
                    put("kind", JsonPrimitive(kind))
                    fields.forEach { (key, value) -> put(key, JsonPrimitive(value)) }
                },
            ),
        )
    }

    private companion object {
        /** `getThermalHeadroom`'s forecast window — the value Android's own docs use. */
        const val FORECAST_SECONDS = 10
    }
}
