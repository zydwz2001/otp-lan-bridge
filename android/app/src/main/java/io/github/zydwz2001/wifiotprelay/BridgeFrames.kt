package io.github.zydwz2001.wifiotprelay

import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** A four-byte big-endian byte length followed by one UTF-8 protocol message. */
internal object BridgeFrames {
    const val MAX_BYTES = 32 * 1024

    fun read(input: DataInputStream): String {
        val size = input.readInt()
        require(size in 1..MAX_BYTES) { "Invalid frame size" }
        val bytes = ByteArray(size)
        input.readFully(bytes)
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    }

    fun write(output: DataOutputStream, message: String) {
        val bytes = message.toByteArray(Charsets.UTF_8)
        require(bytes.size in 1..MAX_BYTES) { "Invalid frame size" }
        output.writeInt(bytes.size)
        output.write(bytes)
        output.flush()
    }
}
