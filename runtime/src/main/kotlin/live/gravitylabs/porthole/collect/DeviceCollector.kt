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

    fun install(app: Application): Boolean {
        emitProfile(app)
        watchLifecycle(app)
        watchConfiguration(app)
        watchPower(app)
        watchNetwork(app)
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
                }
            }

            override fun onActivityStopped(activity: Activity) {
                started = (started - 1).coerceAtLeast(0)
                if (started == 0 && foreground) {
                    foreground = false
                    emit(DeviceEventKinds.BACKGROUND, mapOf("activity" to activity.javaClass.simpleName))
                }
            }

            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
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
}
