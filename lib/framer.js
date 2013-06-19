// The framer consists of two transform streams: the Serializer and the Deserializer
var Transform = require('stream').Transform

// Serializer
// ----------

function Serializer() {
  Transform.call(this, { objectMode: true })
}
Serializer.prototype = Object.create(Transform.prototype, { constructor: { value: Serializer } })

Serializer.prototype._transform = function _transform(frame, encoding, done) {
  var payload = Serializer[frame.type](frame)
  frame.length = payload.length
  var header = this.commonHeader(frame)

  this.push(header)
  this.push(payload)
  done()
}

// Deserializer
// ------------

function Deserializer() {
  Transform.call(this, { objectMode: true })
  this._waiting_for_header = true
  this._cursor = 0
  this._buffer = new Buffer(8)
}
Deserializer.prototype = Object.create(Transform.prototype, { constructor: { value: Serializer } })

Deserializer.prototype._next = function(size, waiting_for_header) {
  this._cursor = 0
  this._buffer = new Buffer(size)
  this._waiting_for_header = waiting_for_header
}

Deserializer.prototype._transform = function _transform(chunk, encoding, done) {
  var cursor = 0

  while(cursor < chunk.length) {
    var to_copy = Math.max(chunk.length - cursor, this._buffer.length - this._cursor)
    chunk.copy(this._buffer, this._cursor, cursor, cursor + to_copy)
    this._cursor += to_copy
    cursor += to_copy

    if (this._cursor === this._buffer.length) {
      if (this._waiting_for_header) {
        this._header = this.commonHeader(this._buffer)
        this._next(this._header.length, false)

      } else {
        var frame = Deserializer[this._header.type](this._buffer)
        frame.type = this._header.type
        frame.flags = this._header.flags
        frame.stream = this._header.stream
        this.push(frame)
        this._next(8, true)
      }
    }
  }

  done()
}

// Frame Header
// ------------
//
// HTTP/2.0 frames share a common base format consisting of an 8-byte header followed by 0 to 65535
// bytes of data.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |         Length (16)           |   Type (8)    |   Flags (8)   |
//     +-+-------------+---------------+-------------------------------+
//     |R|                 Stream Identifier (31)                      |
//     +-+-------------------------------------------------------------+
//     |                     Frame Data (0...)                       ...
//     +---------------------------------------------------------------+

var frame_types = []

var frame_flags = {}

Serializer.commonHeader = function writeCommonHeader(frame) {
  var data = new Buffer(8)

  if (payload_size > 65535) throw new Error('Too large frame: ' + frame.length + ' bytes')
  data.writeUInt16BE(0, frame.length)

  var type_id = frame_types.indexOf(frame.type)
  if (type_id === -1) throw new Error('Unknown frame type: ' + frame.type)
  data.writeUInt8BE (2, type_id)

  var flag_byte = 0
  for (var flag in frame.flags) {
    var position = frame_flags[frame.type].indexOf(flag)
    if (position === -1) throw new Error('Unknown flag for frame type ' + frame.type + ': ' + flag)
    if (frame.flags[flag]) flag_byte |= (1 << position)
  }
  data.writeUInt8BE (3, flag_byte)

  if (frame.stream > 0x7fffffff) throw new Error('Too large stream ID: ' + frame.stream)
  data.writeUInt32BE(4, frame.stream || 0)

  return data
}

Deserializer.commonHeader = function readCommonHeader(buffer) {
  var frame = {}

  frame.length = buffer.readUInt16BE(0)

  frame.type = frame_types[buffer.readUInt8BE(2)]

  frame.flags = {}
  var flag_byte = buffer.readUInt8BE(3)
  var defined_flags = frame_flags[frame.type]
  for (var i = 0; i < defined_flags.length; i++) {
    frame.flags[defined_flags[i]] = Boolean(flag_byte & (1 << i))
  }

  frame.stream = buffer.readUInt32BE(4) & 0x7fffffff

  return frame
}

// DATA Frames
// -----------
//
// DATA frames (type=0x0) convey arbitrary, variable-length sequences of octets associated with a
// stream.
//
// The DATA frame does not define any type-specific flags.

frame_types[0x0] = 'DATA'

frame_flags['DATA'] = []

Serializer['DATA'] = function writeData(frame) {
  return frame.data
}

Deserializer['DATA'] = function readData(buffer) {
  return { data: buffer }
}

// HEADERS+PRIORITY
// ----------------
//
// The HEADERS+PRIORITY frame (type=0x1) allows the sender to set header fields and stream priority
// at the same time.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                   Priority (31)                             |
//     +-+-------------------------------------------------------------+
//     |                    Header Block (*)                         ...
//     +---------------------------------------------------------------+
//
// The HEADERS+PRIORITY frame is identical to the HEADERS frame (Section 3.8.9), preceded by a
// single reserved bit and a 31-bit priority; see Section 3.4.2.
//
// HEADERS+PRIORITY uses the same flags as the HEADERS frame, except that a HEADERS+PRIORITY frame
// with a CONTINUES bit MUST be followed by another HEADERS+PRIORITY frame. See HEADERS frame
// (Section 3.8.9) for any flags.

frame_types[0x1] = 'HEADERS+PRIORITY'

frame_flags['HEADERS+PRIORITY'] = ['CONTINUES']

Serializer['HEADERS+PRIORITY'] = function writeHeadersPriority(frame) {
  var data = new Buffer(4 + frame.data.length)
  data.writeUInt32BE(frame.priority & 0x7fffffff, 0)
  frame.data.copy(data, 4)
  return data
}

Deserializer['HEADERS+PRIORITY'] = function readHeadersPriority(buffer) {
  return {
    priority: buffer.readUInt32BE(0) & 0x7fffffff,
    data: buffer.slice(4)
  }
}

// PRIORITY
// --------
//
// The PRIORITY frame (type=0x2) specifies the sender-advised priority of a stream.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                   Priority (31)                             |
//     +-+-------------------------------------------------------------+
//
// The payload of a PRIORITY frame contains a single reserved bit and a 31-bit priority.

frame_types[0x2] = 'PRIORITY'

frame_flags['PRIORITY'] = []

Serializer['PRIORITY'] = function writePriority(frame) {
  var data = new Buffer(4)
  data.writeUInt32BE(frame.priority, 0)
  return data
}

Deserializer['PRIORITY'] = function readPriority(buffer) {
  return {
    priority: buffer.readUInt32BE(0)
  }
}

// RST_STREAM
// ----------
//
// The RST_STREAM frame (type=0x3) allows for abnormal termination of a stream.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |                         Error Code (32)                       |
//     +---------------------------------------------------------------+
//
// The RST_STREAM frame contains a single unsigned, 32-bit integer identifying the error
// code (Section 3.5.3). The error code indicates why the stream is being terminated.
//
// No type-flags are defined.

frame_types[0x3] = 'RST_STREAM'

frame_flags['RST_STREAM'] = []

Serializer['RST_STREAM'] = function writeRstStream(frame) {
  var data = new Buffer(4)
  data.writeUInt32BE(frame.error, 0)
  return data
}

Deserializer['RST_STREAM'] = function readRstStream(buffer) {
  return {
    error: buffer.readUInt32BE(0)
  }
}

// SETTINGS
// ------------
//
// The SETTINGS frame (type=0x4) conveys configuration parameters that affect how endpoints
// communicate.
//
// The SETTINGS frame defines the following flag:
//
// * CLEAR_PERSISTED (0x2):
//   Bit 2 being set indicates a request to clear any previously persisted settings before
//   processing the settings.

frame_types[0x4] = 'SETTINGS'

frame_flags['SETTINGS'] = ['CLEAR_PERSISTED']

Serializer['SETTINGS'] = function writeSettings(frame) {

}

Deserializer['SETTINGS'] = function readSettings(buffer) {

}

// PUSH_PROMISE
// ------------
//
// The PUSH_PROMISE frame (type=0x5) is used to notify the peer endpoint in advance of streams the
// sender intends to initiate. The PUSH_PROMISE frame includes the unsigned 31-bit identifier of
// the stream the endpoint plans to create along with a minimal set of headers that provide
// additional context for the stream.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                Promised-Stream-ID (31)                      |
//     +-+-------------------------------------------------------------+
//     |                    Header Block (*)                         ...
//     +---------------------------------------------------------------+
//
// PUSH_PROMISE uses the same flags as the HEADERS frame, except that a PUSH_PROMISE frame with a
// CONTINUES bit MUST be followed by another PUSH_PROMISE frame. See HEADERS frame (Section 3.8.9)
// for any flags.

frame_types[0x5] = 'PUSH_PROMISE'

frame_flags['PUSH_PROMISE'] = ['CONTINUES']

Serializer['PUSH_PROMISE'] = function writePushPromise(frame) {
  var data = new Buffer(4 + frame.data.length)
  data.writeUInt32BE(frame.promised_stream & 0x7fffffff, 0)
  frame.data.copy(data, 4)
  return data
}

Deserializer['PUSH_PROMISE'] = function readPushPromise(buffer) {
  return {
    promised_stream: buffer.readUInt32BE(0) & 0x7fffffff,
    data: buffer.slice(4)
  }
}

// PING
// ----
//
// The PING frame (type=0x6) is a mechanism for measuring a minimal round-trip time from the
// sender, as well as determining whether an idle connection is still functional.
//
// In addition to the frame header, PING frames MUST contain 8 additional octets of opaque data.
//
// The PING frame defines one type-specific flag:
//
// * PONG (0x2):
//   Bit 2 being set indicates that this PING frame is a PING response.

frame_types[0x6] = 'PING'

frame_flags['PING'] = ['PONG']

Serializer['PING'] = function writePing(frame) {
  var payload = frame.data
  if (!payload || payload.length !== 8) throw new Error('PING frames must carry an 8 byte payload.')
  return payload
}

Deserializer['PING'] = function readPing(buffer) {
  return {
    data: buffer
  }
}

// GOAWAY
// ------
//
// The GOAWAY frame (type=0x7) informs the remote peer to stop creating streams on this connection.
//
//     0                   1                   2                   3
//     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                  Last-Stream-ID (31)                        |
//     +-+-------------------------------------------------------------+
//     |                      Error Code (32)                          |
//     +---------------------------------------------------------------+
//
// The GOAWAY frame does not define any type-specific flags.
//
// The last stream identifier in the GOAWAY frame contains the highest numbered stream identifier
// for which the sender of the GOAWAY frame has received frames on and might have taken some action
// on.
//
// The GOAWAY frame also contains a 32-bit error code (Section 3.5.3) that contains the reason for
// closing the connection.

frame_types[0x7] = 'GOAWAY'

frame_flags['GOAWAY'] = []

Serializer['GOAWAY'] = function writeGoaway(frame) {
  var data = new Buffer(8)
  data.writeUInt32BE(frame.last_stream & 0x7fffffff, 0)
  data.writeUInt32BE(frame.error, 4)
  return data
}

Deserializer['GOAWAY'] = function readGoaway(buffer) {
  return {
    last_stream: buffer.readUInt32BE(0) & 0x7fffffff,
    error: buffer.readUInt32BE(4)
  }
}

// HEADERS
// -------
//
// The HEADERS frame (type=0x8) provides header fields for a stream.
//
// Additional type-specific flags for the HEADERS frame are:
//
// * CONTINUES (0x2):
//   The CONTINUES bit indicates that this frame does not contain the entire payload necessary to
//   provide a complete set of headers.
//
// The payload of a HEADERS frame contains a Headers Block (Section 3.7).

frame_types[0x8] = 'HEADERS'

frame_flags['HEADERS'] = ['CONTINUES']

Serializer['HEADERS'] = function writeHeaders(frame) {
  return frame.data
}

Deserializer['HEADERS'] = function readHeaders(buffer) {
  return { data: buffer }
}

// WINDOW_UPDATE
// -------------
//
// The WINDOW_UPDATE frame (type=0x9) is used to implement flow control.
//
// The following additional flags are defined for the WINDOW_UPDATE frame:
//
// * END_FLOW_CONTROL (0x2):
//   Bit 2 being set indicates that flow control for the identified stream
//   or connection has been ended; subsequent frames do not need to be flow controlled.
//
// The payload of a WINDOW_UPDATE frame is a 32-bit value indicating the additional number of bytes
// that the sender can transmit in addition to the existing flow control window. The legal range
// for this field is 1 to 2^31 - 1 (0x7fffffff) bytes; the most significant bit of this value is
// reserved.

frame_types[0x9] = 'WINDOW_UPDATE'

frame_flags['WINDOW_UPDATE'] = ['END_FLOW_CONTROL']

Serializer['WINDOW_UPDATE'] = function writeWindowUpdate(frame) {
  var data = new Buffer(4)
  data.writeUInt32BE(frame.window_size & 0x7fffffff, 0)
  return data
}

Deserializer['WINDOW_UPDATE'] = function readWindowUpdate(buffer) {
  return {
    window_size: buffer.readUInt32BE(0) & 0x7fffffff
  }
}

// Common Flags
// ------------
//
// The least significant bit (0x1) - the FINAL bit - is defined for all frame types as an indication
// that this frame is the last the endpoint will send for the identified stream.

for (var i = 0; i < frame_flags.length; i++) frame_flags[i].unshift('FINAL')
