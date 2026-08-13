package io.github.zydwz2001.wifiotprelay

import android.app.Application

class BridgeApplication : Application() {
    lateinit var coordinator: BridgeCoordinator
        private set

    override fun onCreate() {
        super.onCreate()
        coordinator = BridgeCoordinator(this)
    }
}
