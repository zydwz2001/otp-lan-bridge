package dev.otplanbridge

import android.app.Application

class BridgeApplication : Application() {
    lateinit var coordinator: BridgeCoordinator
        private set

    override fun onCreate() {
        super.onCreate()
        coordinator = BridgeCoordinator(this)
    }
}
