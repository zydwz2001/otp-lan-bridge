package io.github.zydwz2001.wifiotprelay

import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** ADB opens this phone-local endpoint. Never exposed to Wi-Fi or mobile data. */
class BridgeUsbServer(private val protocol: BridgeProtocol) {
    private val listener = ServerSocket()
    private val peers = ConcurrentHashMap.newKeySet<Peer>()
    val isRunning get() = listener.isBound && !listener.isClosed

    fun start() {
        listener.reuseAddress = true
        listener.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 4)
        Thread({ acceptLoop() }, "bridge-usb-accept").apply { isDaemon = true; start() }
    }

    private fun acceptLoop() {
        while (!listener.isClosed) {
            val socket = try { listener.accept() } catch (_: Exception) { break }
            if (!socket.inetAddress.isLoopbackAddress || peers.size >= 4) {
                socket.close()
                continue
            }
            socket.soTimeout = 65_000
            socket.tcpNoDelay = true
            val peer = Peer(socket)
            peers.add(peer)
            peer.start()
        }
    }

    fun stopSafely() {
        try { listener.close() } catch (_: Exception) { /* Already stopped. */ }
        peers.toList().forEach { it.close(1001, "Service stopped") }
    }

    private inner class Peer(private val socket: Socket) : BridgeConnection {
        private val closed = AtomicBoolean(false)
        private val outgoing = ArrayBlockingQueue<String>(32)
        private lateinit var writerThread: Thread
        override val isOpen get() = !closed.get() && !socket.isClosed

        fun start() {
            protocol.onOpen(this)
            writerThread = Thread({
                try {
                    val output = DataOutputStream(socket.getOutputStream())
                    while (isOpen) BridgeFrames.write(output, outgoing.take())
                } catch (_: Exception) { /* Do not log message payloads. */ }
                finally { close(1001, "Connection closed") }
            }, "bridge-usb-write").apply { isDaemon = true; start() }
            Thread({
                try {
                    val input = DataInputStream(socket.getInputStream())
                    while (isOpen) protocol.onMessage(this, BridgeFrames.read(input))
                } catch (_: Exception) { /* EOF, timeout, or invalid frame. */ }
                finally { close(1001, "Connection closed") }
            }, "bridge-usb-read").apply { isDaemon = true; start() }
        }

        override fun send(message: String) {
            check(isOpen && outgoing.offer(message)) { "Connection unavailable" }
        }

        override fun close(code: Int, reason: String) {
            if (!closed.compareAndSet(false, true)) return
            try { socket.close() } catch (_: Exception) { /* Already stopped. */ }
            if (::writerThread.isInitialized) writerThread.interrupt()
            peers.remove(this)
            protocol.onClose(this)
        }
    }

    companion object { const val PORT = 42872 }
}
