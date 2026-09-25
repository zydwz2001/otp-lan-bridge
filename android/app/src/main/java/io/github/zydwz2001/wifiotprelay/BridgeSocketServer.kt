package io.github.zydwz2001.wifiotprelay

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap

interface BridgeConnection {
    val isOpen: Boolean
    fun send(message: String)
    fun close(code: Int, reason: String)
}

class BridgeSocketServer(
    address: InetSocketAddress,
    private val protocol: BridgeProtocol,
    private val onFailure: () -> Unit
) : WebSocketServer(address) {
    val hostAddress: String = address.address.hostAddress.orEmpty()
    val listenPort: Int = address.port
    private val peers = ConcurrentHashMap<WebSocket, BridgeConnection>()

    init {
        setReuseAddr(true)
        connectionLostTimeout = 20
    }

    override fun onStart() = Unit

    override fun onOpen(connection: WebSocket, handshake: ClientHandshake) {
        val remote = connection.remoteSocketAddress?.address
        if (remote == null || !isAllowedBridgePeer(remote) || handshake.resourceDescriptor.substringBefore('?') != PATH) {
            connection.close(1008, "Local connections only")
            return
        }
        val peer = object : BridgeConnection {
            override val isOpen get() = connection.isOpen
            override fun send(message: String) = connection.send(message)
            override fun close(code: Int, reason: String) = connection.close(code, reason)
        }
        peers[connection] = peer
        protocol.onOpen(peer)
    }

    override fun onMessage(connection: WebSocket, message: String) {
        peers[connection]?.let { protocol.onMessage(it, message) }
    }

    override fun onClose(connection: WebSocket, code: Int, reason: String?, remote: Boolean) {
        peers.remove(connection)?.let(protocol::onClose)
    }

    override fun onError(connection: WebSocket?, exception: Exception) {
        if (connection == null) onFailure()
    }

    fun stopSafely() {
        try { stop(1_000) } catch (_: Exception) { /* Already stopped. */ }
        peers.values.forEach(protocol::onClose)
        peers.clear()
    }

    companion object { const val PATH = "/v1/bridge" }
}

internal fun isAllowedBridgePeer(address: InetAddress): Boolean =
    address.isSiteLocalAddress && !address.isLoopbackAddress && !address.isLinkLocalAddress
