// The framer consists of two [Transform Stream][1] subclasses that operate in [object mode][2]:
// the Serializer and the Deserializer
// [1]: http://nodejs.org/api/stream.html#stream_class_stream_transform
// [2]: http://nodejs.org/api/stream.html#stream_new_stream_readable_options
var Transform = require('stream').Transform;

exports.Serializer = Serializer;
exports.Deserializer = Deserializer;

// Serializer
// ----------
//
//     Frame Objects
//     * * * * * * * --+---------------------------
//                     |                          |
//                     v                          v           Buffers
//      [] -----> Payload Ser. --[buffers]--> Header Ser. --> * * * *
//     empty      adds payload                adds header
//     array        buffers                     buffer

function Serializer() {
  Transform.call(this, { objectMode: true });
}
Serializer.prototype = Object.create(Transform.prototype, { constructor: { value: Serializer } });

// When there's an incoming frame object, it first generates the frame type specific part of the
// frame (payload), and then then adds the header part which holds fields that are common to all
// frame types (like the length of the payload).
Serializer.prototype._transform = function _transform(frame, encoding, done) {
  if (!(frame.type in Serializer)) {
    throw new Error('Unknown frame type: ' + frame.type);
  }

  var buffers = [];
  Serializer[frame.type](frame, buffers);
  Serializer.commonHeader(frame, buffers);

  for (var i = 0; i < buffers.length; i++) {
    this.push(buffers[i]);
  }
  done();
};

// Deserializer
// ------------
//
//     Buffers
//     * * * * --------+-------------------------
//                     |                        |
//                     v                        v           Frame Objects
//      {} -----> Header Des. --{frame}--> Payload Des. --> * * * * * * *
//     empty      adds parsed              adds parsed
//     object  header properties        payload properties

function Deserializer() {
  Transform.call(this, { objectMode: true });
  this._next(8);
}
Deserializer.prototype = Object.create(Transform.prototype, { constructor: { value: Deserializer } })

// The Deserializer is stateful, and it's two main alternating states are: *waiting for header* and
// *waiting for payload*. The state is stored in the boolean property `_waiting_for_header`.
//
// When entering a new state, a `_buffer` is created that will hold the accumulated data (header or
// payload). The `_cursor` is used to track the progress.
Deserializer.prototype._next = function(size) {
  this._cursor = 0;
  this._buffer = new Buffer(size);
  this._waiting_for_header = !this._waiting_for_header;
  if (this._waiting_for_header) {
    this._frame = {};
  }
};

// Parsing an incoming buffer is an iterative process because it can hold multiple frames if it's
// large enough. A `cursor` is used to track the progress in parsing the incoming `chunk`.
Deserializer.prototype._transform = function _transform(chunk, encoding, done) {
  var cursor = 0;

  while(cursor < chunk.length) {
    // The content of an incoming buffer is first copied to `_buffer`. If it can't hold the full
    // chunk, then only a part of it is copied.
    var to_copy = Math.min(chunk.length - cursor, this._buffer.length - this._cursor);
    chunk.copy(this._buffer, this._cursor, cursor, cursor + to_copy);
    this._cursor += to_copy;
    cursor += to_copy;

    // When `_buffer` is full, it's content gets parsed either as header or payload depending on
    // the actual state.
    if (this._cursor === this._buffer.length) {
      if (this._waiting_for_header) {
        // If it's header then the parsed data is stored in a temporary variable and then the
        // deserializer waits for the specified length payload.
        Deserializer.commonHeader(this._buffer, this._frame);
        this._next(this._frame.length);

      } else {
        // If it's payload then the the frame object is finalized and then gets pushed out.
        // Unknown frame types are ignored.
        if (this._frame.type) {
          try {
            Deserializer[this._frame.type](this._buffer, this._frame);
            this.push(this._frame);
          } catch(error) {
            this.emit('error', error);
          }
        }
        this._next(8);
      }
    }
  }

  done();
};

// [Frame Header](http://http2.github.io/http2-spec/#FrameHeader)
// --------------------------------------------------------------
//
// HTTP/2.0 frames share a common base format consisting of an 8-byte header followed by 0 to 65535
// bytes of data.
//
//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |         Length (16)           |   Type (8)    |   Flags (8)   |
//     +-+-------------+---------------+-------------------------------+
//     |R|                 Stream Identifier (31)                      |
//     +-+-------------------------------------------------------------+
//     |                     Frame Data (0...)                       ...
//     +---------------------------------------------------------------+
//
// The fields of the frame header are defined as:
//
// * Length:
//   The length of the frame data expressed as an unsigned 16-bit integer. The 8 bytes of the frame
//   header are not included in this value.
//
// * Type:
//   The 8-bit type of the frame. The frame type determines how the remainder of the frame header
//   and data are interpreted. Implementations MUST ignore unsupported and unrecognized frame types.
//
// * Flags:
//   An 8-bit field reserved for frame-type specific boolean flags.
//
//   Flags are assigned semantics specific to the indicated frame type. Flags that have no defined
//   semantics for a particular frame type MUST be ignored, and MUST be left unset (0) when sending.
//
// * R:
//   A reserved 1-bit field. The semantics of this bit are undefined and the bit MUST remain unset
//   (0) when sending and MUST be ignored when receiving.
//
// * Stream Identifier:
//   A 31-bit stream identifier (see Section 3.4.1). A value 0 is reserved for frames that are
//   associated with the connection as a whole as opposed to an individual stream.
//
// The structure and content of the remaining frame data is dependent entirely on the frame type.

var frame_types = [];

var frame_flags = {};

Serializer.commonHeader = function writeCommonHeader(frame, buffers) {
  var header_buffer = new Buffer(8);

  var size = 0;
  for (var i = 0; i < buffers.length; i++) size += buffers[i].length;
  if (size > 65535) {
    throw new Error('Too large frame: ' + size + ' bytes');
  }
  header_buffer.writeUInt16BE(size, 0);

  var type_id = frame_types.indexOf(frame.type);  // If we are here then the type is valid for sure
  header_buffer.writeUInt8(type_id, 2);

  var flag_byte = 0;
  for (var flag in frame.flags) {
    var position = frame_flags[frame.type].indexOf(flag);
    if (position === -1) {
      throw new Error('Unknown flag for frame type ' + frame.type + ': ' + flag);
    }
    if (frame.flags[flag]) {
      flag_byte |= (1 << position);
    }
  }
  header_buffer.writeUInt8(flag_byte, 3);

  if (frame.stream > 0x7fffffff) {
    throw new Error('Too large stream ID: ' + frame.stream);
  }
  header_buffer.writeUInt32BE(frame.stream || 0, 4);

  buffers.unshift(header_buffer);
};

Deserializer.commonHeader = function readCommonHeader(buffer, frame) {
  frame.length = buffer.readUInt16BE(0);

  frame.type = frame_types[buffer.readUInt8(2)];

  frame.flags = {};
  var flag_byte = buffer.readUInt8(3);
  var defined_flags = frame_flags[frame.type];
  for (var i = 0; i < defined_flags.length; i++) {
    frame.flags[defined_flags[i]] = Boolean(flag_byte & (1 << i));
  }

  frame.stream = buffer.readUInt32BE(4) & 0x7fffffff;
};

// Frame types
// ===========

// [DATA Frames](http://http2.github.io/http2-spec/#DataFrames)
// ------------------------------------------------------------
//
// DATA frames (type=0x0) convey arbitrary, variable-length sequences of octets associated with a
// stream.
//
// The DATA frame defines the following flags:
//
// * END_STREAM (0x1):
//   Bit 1 being set indicates that this frame is the last that the endpoint will send for the
//   identified stream.
// * RESERVED (0x2):
//   Bit 2 is reserved for future use.

frame_types[0x0] = 'DATA';

frame_flags.DATA = ['END_STREAM', 'RESERVED'];

Serializer.DATA = function writeData(frame, buffers) {
  buffers.push(frame.data);
};

Deserializer.DATA = function readData(buffer, frame) {
  frame.data = buffer;
};

// [HEADERS](http://http2.github.io/http2-spec/#HEADERS)
// --------------------------------------------------------------
//
// The HEADERS frame (type=0x1) allows the sender to create a stream.
//
// The HEADERS frame defines the following flags:
//
// * END_STREAM (0x1):
//   Bit 1 being set indicates that this frame is the last that the endpoint will send for the
//   identified stream.
// * RESERVED (0x2):
//   Bit 2 is reserved for future use.
// * END_HEADERS (0x4):
//   The END_HEADERS bit indicates that this frame contains the entire payload necessary to provide
//   a complete set of headers.
// * PRIORITY (0x8):
//   Bit 4 being set indicates that the first four octets of this frame contain a single reserved
//   bit and a 31-bit priority.

frame_types[0x1] = 'HEADERS';

frame_flags.HEADERS = ['END_STREAM', 'RESERVED', 'END_HEADERS', 'PRIORITY'];

//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|               (Optional) Priority (31)                      |
//     +-+-------------------------------------------------------------+
//     |                    Header Block (*)                         ...
//     +---------------------------------------------------------------+
//
// The payload of a HEADERS frame contains a Headers Block

Serializer.HEADERS = function writeHeadersPriority(frame, buffers) {
  if (frame.flags.PRIORITY) {
    var buffer = new Buffer(4);
    buffer.writeUInt32BE(frame.priority & 0x7fffffff, 0);
    buffers.push(buffer);
  }
  buffers.push(frame.data);
};

Deserializer.HEADERS = function readHeadersPriority(buffer, frame) {
  if (frame.flags.PRIORITY) {
    frame.priority = buffer.readUInt32BE(0) & 0x7fffffff;
    frame.data = buffer.slice(4);
  } else {
    frame.data = buffer;
  }
};

// [PRIORITY](http://http2.github.io/http2-spec/#PRIORITY)
// -------------------------------------------------------
//
// The PRIORITY frame (type=0x2) specifies the sender-advised priority of a stream.
//
// The PRIORITY frame does not define any flags.

frame_types[0x2] = 'PRIORITY';

frame_flags.PRIORITY = [];

//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                   Priority (31)                             |
//     +-+-------------------------------------------------------------+
//
// The payload of a PRIORITY frame contains a single reserved bit and a 31-bit priority.

Serializer.PRIORITY = function writePriority(frame, buffers) {
  var buffer = new Buffer(4);
  buffer.writeUInt32BE(frame.priority, 0);
  buffers.push(buffer);
};

Deserializer.PRIORITY = function readPriority(buffer, frame) {
  frame.priority = buffer.readUInt32BE(0);
};

// [RST_STREAM](http://http2.github.io/http2-spec/#RST_STREAM)
// -----------------------------------------------------------
//
// The RST_STREAM frame (type=0x3) allows for abnormal termination of a stream.
//
// No type-flags are defined.

frame_types[0x3] = 'RST_STREAM';

frame_flags.RST_STREAM = [];

//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |                         Error Code (32)                       |
//     +---------------------------------------------------------------+
//
// The RST_STREAM frame contains a single unsigned, 32-bit integer identifying the error
// code (see Error Codes). The error code indicates why the stream is being terminated.

Serializer.RST_STREAM = function writeRstStream(frame, buffers) {
  var buffer = new Buffer(4);
  buffer.writeUInt32BE(error_codes.indexOf(frame.error), 0);
  buffers.push(buffer);
};

Deserializer.RST_STREAM = function readRstStream(buffer, frame) {
  frame.error = error_codes[buffer.readUInt32BE(0)];
};

// [SETTINGS](http://http2.github.io/http2-spec/#SETTINGS)
// -------------------------------------------------------
//
// The SETTINGS frame (type=0x4) conveys configuration parameters that affect how endpoints
// communicate.
//
// The SETTINGS frame does not define any flags.

frame_types[0x4] = 'SETTINGS';

frame_flags.SETTINGS = [];

// The payload of a SETTINGS frame consists of zero or more settings. Each setting consists of an
// 8-bit reserved field, an unsigned 24-bit setting identifier, and an unsigned 32-bit value.
//
//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |  Reserved(8)  |             Setting Identifier (24)           |
//     +---------------+-----------------------------------------------+
//     |                        Value (32)                             |
//     +---------------------------------------------------------------+
//
// A SETTINGS frame is not required to include every defined setting; senders can include only those
// parameters for which it has accurate values and a need to convey. When multiple parameters are
// sent, they SHOULD be sent in order of numerically lowest ID to highest ID. A single SETTINGS
// frame MUST NOT contain multiple values for the same ID. If the receiver of a SETTINGS frame
// discovers multiple values for the same ID, it MUST ignore all values for that ID except the first
// one.

Serializer.SETTINGS = function writeSettings(frame, buffers) {
  var settings = [], settings_left = Object.keys(frame.settings);
  defined_settings.forEach(function(setting, id) {
    if (setting.name in frame.settings) {
      settings_left.splice(settings_left.indexOf(setting.name), 1);
      var value = frame.settings[setting.name];
      settings.push({ id: id, value: setting.flag ? Boolean(value) : value });
    }
  });
  if (settings_left.length !== 0) {
    throw new Error('Unknown settings: ' + settings_left.join(', '))
  }

  var buffer = new Buffer(settings.length * 8);
  for (var i = 0; i < settings.length; i++) {
    buffer.writeUInt32BE(settings[i].id & 0xffffff, i*8);
    buffer.writeUInt32BE(settings[i].value, i*8 + 4);
  }

  buffers.push(buffer);
};

Deserializer.SETTINGS = function readSettings(buffer, frame) {
  frame.settings = {};

  if (buffer.length % 8 !== 0) {
    throw new Error('Invalid SETTINGS frame.');
  }
  for (var i = 0; i < buffer.length / 8; i++) {
    var id = buffer.readUInt32BE(i*8) & 0xffffff;
    var setting = defined_settings[id];
    var value = buffer.readUInt32BE(i*8 + 4);
    if (!setting || setting.name in frame.settings) {
      continue;
    }
    frame.settings[setting.name] = setting.flag ? Boolean(value & 0x1) : value;
  }

  return frame;
};

// The following settings are defined:
var defined_settings = [];

// * SETTINGS_MAX_CONCURRENT_STREAMS (4):
//   indicates the maximum number of concurrent streams that the sender will allow.
defined_settings[4] = { name: 'SETTINGS_MAX_CONCURRENT_STREAMS', flag: false };

// * SETTINGS_INITIAL_WINDOW_SIZE (7):
//   indicates the sender's initial stream window size (in bytes) for new streams.
defined_settings[7] = { name: 'SETTINGS_INITIAL_WINDOW_SIZE', flag: false };

// * SETTINGS_FLOW_CONTROL_OPTIONS (10):
//   indicates that streams directed to the sender will not be subject to flow control. The least
//   significant bit (0x1) is set to indicate that new streams are not flow controlled. All other
//   bits are reserved.
defined_settings[10] = { name: 'SETTINGS_FLOW_CONTROL_OPTIONS', flag: true };

// [PUSH_PROMISE](http://http2.github.io/http2-spec/#PUSH_PROMISE)
// ---------------------------------------------------------------
//
// The PUSH_PROMISE frame (type=0x5) is used to notify the peer endpoint in advance of streams the
// sender intends to initiate.
//
// The PUSH_PROMISE frame defines the following flags:
//
// * END_PUSH_PROMISE (0x1):
//   The END_PUSH_PROMISE bit indicates that this frame contains the entire payload necessary to
//   provide a complete set of headers.

frame_types[0x5] = 'PUSH_PROMISE';

frame_flags.PUSH_PROMISE = ['END_PUSH_PROMISE'];

//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                Promised-Stream-ID (31)                      |
//     +-+-------------------------------------------------------------+
//     |                    Header Block (*)                         ...
//     +---------------------------------------------------------------+
//
// The PUSH_PROMISE frame includes the unsigned 31-bit identifier of
// the stream the endpoint plans to create along with a minimal set of headers that provide
// additional context for the stream.

Serializer.PUSH_PROMISE = function writePushPromise(frame, buffers) {
  var buffer = new Buffer(4);
  buffer.writeUInt32BE(frame.promised_stream & 0x7fffffff, 0);
  buffers.push(buffer);
  buffers.push(frame.data);
};

Deserializer.PUSH_PROMISE = function readPushPromise(buffer, frame) {
  frame.promised_stream = buffer.readUInt32BE(0) & 0x7fffffff;
  frame.data = buffer.slice(4);
};

// [PING](http://http2.github.io/http2-spec/#PING)
// -----------------------------------------------
//
// The PING frame (type=0x6) is a mechanism for measuring a minimal round-trip time from the
// sender, as well as determining whether an idle connection is still functional.
//
// The PING frame defines one type-specific flag:
//
// * PONG (0x2):
//   Bit 2 being set indicates that this PING frame is a PING response.

frame_types[0x6] = 'PING';

frame_flags.PING = ['PONG'];

// In addition to the frame header, PING frames MUST contain 8 additional octets of opaque data.

Serializer.PING = function writePing(frame, buffers) {
  if (!frame.data || frame.data.length !== 8) {
    throw new Error('PING frames must carry an 8 byte payload.');
  }
  buffers.push(frame.data);
}

Deserializer.PING = function readPing(buffer, frame) {
  if (buffer.length !== 8) {
    throw new Error('Invalid size PING frame.');
  }
  frame.data = buffer;
}

// [GOAWAY](http://http2.github.io/http2-spec/#GOAWAY)
// ---------------------------------------------------
//
// The GOAWAY frame (type=0x7) informs the remote peer to stop creating streams on this connection.
//
// The GOAWAY frame does not define any flags.

frame_types[0x7] = 'GOAWAY';

frame_flags.GOAWAY = [];

//      0                   1                   2                   3
//      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//     |X|                  Last-Stream-ID (31)                        |
//     +-+-------------------------------------------------------------+
//     |                      Error Code (32)                          |
//     +---------------------------------------------------------------+
//
// The last stream identifier in the GOAWAY frame contains the highest numbered stream identifier
// for which the sender of the GOAWAY frame has received frames on and might have taken some action
// on.
//
// The GOAWAY frame also contains a 32-bit error code (see Error Codes) that contains the reason for
// closing the connection.

Serializer.GOAWAY = function writeGoaway(frame, buffers) {
  var buffer = new Buffer(8);
  buffer.writeUInt32BE(frame.last_stream & 0x7fffffff, 0);
  buffer.writeUInt32BE(error_codes.indexOf(frame.error), 4);
  buffers.push(buffer);
};

Deserializer.GOAWAY = function readGoaway(buffer, frame) {
  frame.last_stream = buffer.readUInt32BE(0) & 0x7fffffff;
  frame.error = error_codes[buffer.readUInt32BE(4)];
};

// [WINDOW_UPDATE](http://http2.github.io/http2-spec/#WINDOW_UPDATE)
// -----------------------------------------------------------------
//
// The WINDOW_UPDATE frame (type=0x9) is used to implement flow control.
//
// The WINDOW_UPDATE frame defines the following flags:
//
// * END_FLOW_CONTROL (0x1):
//   Bit 1 being set indicates that flow control for the identified stream
//   or connection has been ended; subsequent frames do not need to be flow controlled.

frame_types[0x9] = 'WINDOW_UPDATE';

frame_flags.WINDOW_UPDATE = ['END_FLOW_CONTROL'];

// The payload of a WINDOW_UPDATE frame is a 32-bit value indicating the additional number of bytes
// that the sender can transmit in addition to the existing flow control window. The legal range
// for this field is 1 to 2^31 - 1 (0x7fffffff) bytes; the most significant bit of this value is
// reserved.

Serializer.WINDOW_UPDATE = function writeWindowUpdate(frame, buffers) {
  var buffer = new Buffer(4);
  buffer.writeUInt32BE(frame.window_size & 0x7fffffff, 0);
  buffers.push(buffer);
};

Deserializer.WINDOW_UPDATE = function readWindowUpdate(buffer, frame) {
  frame.window_size = buffer.readUInt32BE(0) & 0x7fffffff;
};

// [Error Codes](http://http2.github.io/http2-spec/#ErrorCodes)
// ------------------------------------------------------------

var error_codes = [
  'NO_ERROR',
  'PROTOCOL_ERROR',
  'INTERNAL_ERROR',
  'FLOW_CONTROL_ERROR',
  ,
  'STREAM_CLOSED',
  'FRAME_TOO_LARGE',
  'REFUSED_STREAM',
  'CANCEL',
  'COMPRESSION_ERROR'
];
