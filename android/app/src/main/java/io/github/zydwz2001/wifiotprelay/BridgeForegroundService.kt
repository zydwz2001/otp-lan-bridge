package io.github.zydwz2001.wifiotprelay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock

class BridgeForegroundService : Service() {
    private val coordinator get() = (application as BridgeApplication).coordinator
    private val handler = Handler(Looper.getMainLooper())
    private var callbackRegistered = false
    private val notificationListenerRecovery = object : Runnable {
        override fun run() {
            if (coordinator.config.bridgeEnabled && coordinator.hasNotificationAccess() && !OtpNotificationListener.isConnected) {
                OtpNotificationListener.requestReconnect(this@BridgeForegroundService)
            }
            handler.postDelayed(this, NOTIFICATION_LISTENER_RETRY_MS)
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = scheduleNetworkRefresh()
        override fun onLost(network: Network) = scheduleNetworkRefresh()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = scheduleNetworkRefresh()
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startAsForeground()
        registerNetworkCallback()
        handler.post(notificationListenerRecovery)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            coordinator.config.bridgeEnabled = false
            coordinator.stopServer()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        coordinator.config.bridgeEnabled = true
        coordinator.startServer()
        OtpNotificationListener.requestReconnect(this)
        return START_STICKY
    }

    override fun onDestroy() {
        if (callbackRegistered) {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
            callbackRegistered = false
        }
        handler.removeCallbacksAndMessages(null)
        coordinator.stopServer()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAsForeground() {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, BridgeForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_wifi_relay)
            .setContentTitle("验证码传递正在运行")
            .setContentText("等待电脑浏览器连接")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.ic_media_pause),
                    "停止传递",
                    stopIntent
                ).build()
            )
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "验证码传递运行状态", NotificationManager.IMPORTANCE_LOW).apply {
            description = "保持验证码传递功能运行"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun registerNetworkCallback() {
        try {
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
            callbackRegistered = true
        } catch (_: Exception) {
            // The status page will still allow a manual service restart.
        }
    }

    private fun scheduleNetworkRefresh() {
        handler.removeCallbacksAndMessages(NETWORK_REFRESH_TOKEN)
        handler.postAtTime({ coordinator.restartServer() }, NETWORK_REFRESH_TOKEN, SystemClock.uptimeMillis() + 800)
    }

    companion object {
        const val ACTION_START = "io.github.zydwz2001.wifiotprelay.action.START"
        const val ACTION_STOP = "io.github.zydwz2001.wifiotprelay.action.STOP"
        private const val CHANNEL_ID = "wifi_relay_status"
        private const val NOTIFICATION_ID = 5201
        private const val NOTIFICATION_LISTENER_RETRY_MS = 30_000L
        private val NETWORK_REFRESH_TOKEN = Any()
    }
}
