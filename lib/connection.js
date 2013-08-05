var assert  = require('assert');
var utils   = require('./utils');
var logging = require('./logging');

// Connection
// ----------

// The Connection class manages HTTP/2 connections. Each instance corresponds to one transport
// stream (TCP stream). It operates by sending and receiving frames and is implemented as an
// [object mode][1] [Duplex stream][2].
//
// [1]: http://nodejs.org/api/stream.html#stream_new_stream_readable_options
// [2]: http://nodejs.org/api/stream.html#stream_class_stream_duplex

var Duplex  = require('stream').Duplex;

exports.Connection = Connection;

// The main aspects of managing the connection are:
function Connection(firstStreamId, settings, log) {
  // * handling IO, particularly multiplexing/demultiplexing incoming and outgoing frames
  Duplex.call(this, { objectMode: true });

  // * logging: every method uses the common logger object
  this._log = (log || logging.root).child({ component: 'connection' });

  // * stream management
  this._initializeStreamManagement(firstStreamId);

  // * settings management
  this._initializeSettingsManagement(settings);

  // * lifecycle management
  this._initializeLifecycleManagement();

  // * flow control
  this._initializeFlowControl();
}
Connection.prototype = Object.create(Duplex.prototype, { constructor: { value: Connection } });

// Overview
// --------

//              |    ^             |    ^
//              v    |             v    |
//         +--------------+   +--------------+
//     +---|   stream1    |---|   stream2    |----      ....      ---+
//     |   | +----------+ |   | +----------+ |                       |
//     |   | | stream1. | |   | | stream2. | |                       |
//     |   +-| upstream |-+   +-| upstream |-+                       |
//     |     +----------+       +----------+                         |
//     |       |     ^             |     ^                           |
//     |       v     |             v     |                           |
//     |       +-----+-------------+-----+--------      ....         |
//     |       ^     |             |     |                           |
//     |       |     v             |     |                           |
//     |   +--------------+        |     |                           |
//     |   |   stream0    |        |     |                           |
//     |   |  connection  |        |     |                           |
//     |   |  management  |     multiplexing                         |
//     |   +--------------+     flow control                         |
//     |                           |     ^                           |
//     |                   _read() |     | _write()                  |
//     |                           v     |                           |
//     |                +------------+ +-----------+                 |
//     |                |output queue| |input queue|                 |
//     +----------------+------------+-+-----------+-----------------+
//                                 |     ^
//                          read() |     | write()
//                                 v     |

// Stream management
// -----------------

var Stream  = require('./stream').Stream;

// Initialization:
Connection.prototype._initializeStreamManagement = function _initializeStreamManagement(firstStreamId) {
  // * streams are stored in two data structures:
  //   * `_streamsIds` is the primary registry of streams. It's a sparse array that serves as an
  //     id -> stream map.
  //
  //   * `_streamPriorities` is an ordered set of streams that are allowed to send data. The order
  //     is determined by stream priorities. (currently, it's order of creation)
  this._streamsIds = [];

  this._streamPriorities = [];

  // * The next outbound stream ID is stored in `this._nextStreamId`
  this._nextStreamId = firstStreamId;

  // * Creating the `_control` stream that corresponds to stream ID 0 (connection level frames).
  this._control = new Duplex({ objectMode: true });
  this._control._write = this._writeControlFrame.bind(this);
  this._control._read = utils.noop;
  this._control.on('readable', this.emit.bind(this, 'stream_readable'));
  this._streamsIds[0] = this._streamPriorities[0] = { upstream: this._control, priority: -1 };

  // * By default, the number of concurrent outbound streams is not limited. The `_streamLimit` can
  //   be set by the SETTINGS_MAX_CONCURRENT_STREAMS setting.
  this._streamCount = 0;
  this._streamLimit = Infinity;
  this._control.on('SETTINGS_MAX_CONCURRENT_STREAMS', this._updateStreamLimit.bind(this));
};

Connection.prototype.getIdOf = function getIdOf(stream) {
  return this._streamsIds.indexOf(stream);
};

// `_writeControlFrame` is called when there's an incoming frame in the `_control` stream. It
// broadcasts the message by creating an event on it.
Connection.prototype._writeControlFrame = function _writeControlFrame(frame, encoding, done) {
  this._control.emit(frame.type, frame);
  done();
};

// Changing the stream count limit
Connection.prototype._updateStreamLimit = function _updateStreamLimit(newStreamLimit) {
  this._streamLimit = newStreamLimit;
  this.emit('stream_slot_change');
};

// Freeing a slot in the stream pool
Connection.prototype._decreaseStreamCount = function _decreaseStreamCount() {
  this._streamCount -= 1;
  this.emit('stream_slot_change');
};

// Creating a new *inbound or outbound* stream with the given `id` consists of two steps:
//
// 1. `var newstream = this._newStream(id);`
//    * creates the new stream and registers it in `this._streamsIds`
// 2. `this._activateStream(newstream);`
//    * adds it to `_streamPriorities` (in the appropriate position)
//    * transforms 'readable' events on the stream to 'stream_readable' events on the connection

Connection.prototype._newStream = function _newStream(id) {
  this._log.trace({ id: id }, 'Adding new stream.');
  var stream = new Stream(this._log.child({ stream: id }));
  this._streamsIds[id] = stream;
  return stream;
};

Connection.prototype._activateStream = function _activateStream(stream) {
  this._log.trace({ id: this.getIdOf(stream) }, 'Activating stream.');
  this._streamPriorities.push(stream);
  stream.upstream.on('readable', this.emit.bind(this, 'stream_readable'));
};

// Creating an *inbound* stream with the given ID. It is called when there's an incoming frame to
// a previously nonexistent stream.
//
// * creating and activating the stream
// * emitting 'stream' event with the new stream
Connection.prototype._incomingStream = function _incomingStream(id) {
  this._log.debug({ id: id }, 'New incoming stream.');
  var stream = this._newStream(id);
  this._activateStream(stream);
  this.emit('stream', stream, id);
  return stream;
};

// Creating an *outbound* stream with the next available ID
Connection.prototype.createStream = function createStream() {
  // * Allocating a new ID with the appropriate parity.
  var id = this._nextStreamId;
  this._nextStreamId += 2;

  this._log.trace({ id: id }, 'Creating new outbound stream.');

  // * Creating a new Stream.
  var stream = this._newStream(id);

  // * Activating the created stream is only possible when there's enough space in the stream pool.
  //   `tryToActivate` tries to activate the stream until it finally succeeds.
  var self = this;
  function tryToActivate() {
    if (self._streamCount >= self._streamLimit) {
      self.once('stream_slot_change', tryToActivate);
    } else {
      self._activateStream(stream);
    }
  }

  // * Starting activation process when
  //   * it becomes 'active' (tries to send a frame)
  //   * and if it is a promised stream, the PUSH_PROMISE is sent
  var promisePending = false;
  stream.once('promise_initiated', function() {
    promisePending = true;
    stream.once('promise_sent', function() {
      promisePending = false;
    });
  });

  stream.once('active', function() {
    if (promisePending) {
      stream.once('promise_sent', tryToActivate);
    } else {
      tryToActivate();
    }
  });

  // * When the stream becomes inactive, decreasing the `_streamCount`
  stream.once('inactive', this._decreaseStreamCount.bind(this));

  return stream;
};

// Multiplexing
// ------------

// The `_read` method is a [virtual method of the Duplex class][1] that has to be implemented by
// child classes. It reads frames from streams and pushes them to the output buffer.
// [1]: http://nodejs.org/api/stream.html#stream_readable_read_size
Connection.prototype._read = function _read() {
  this._log.trace('Starting forwarding frames from streams.');

  // * Looping through the active streams in priority order, forwarding until:
  var moreNeeded = true, stream, id, frame;
  for (var i = 0; i < this._streamPriorities.length && moreNeeded; i++) {
    stream = this._streamPriorities[i];
    id = this.getIdOf(stream);
    while (frame = stream.upstream.read()) {
      frame.stream = id;
      if (frame.type === 'PUSH_PROMISE') {
        frame.promised_stream.emit('promise_sent');
        frame.promised_stream = this.getIdOf(frame.promised_stream);
      }
      moreNeeded = this._send(frame);
    }
  }

  // * there are no more frames in the buffers of the streams, but more would be needed
  //   * coming back once a stream becomes readable again
  if (i === this._streamPriorities.length) {
    this._log.trace('More chunk is needed, but we could not provide more.');
    this.once('stream_readable', this._read.bind(this));
  }

  // * it's not possible to send more because of flow control
  //   * coming back once flow control window is updated
  else if (moreNeeded === null) {
    this._log.trace('We could not send more because of insufficient flow control window.');
    this.once('window_update', this._read.bind(this));
  }

  // * no more chunk needed
  //   * coming back only when `_read` is called again by Duplex
  else if (moreNeeded === false) {
    this._log.trace('No more chunk needed, stopping forwarding.');
  }
};

// The `_write` method is another [virtual method of the Duplex class][1] that has to be implemented
// by child classes. It forwards the given frame to the appropriate stream:
// [1]: http://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback
Connection.prototype._write = function write(frame, encoding, done) {
  // * gets the appropriate stream from the stream registry
  var stream = this._streamsIds[frame.stream];

  // * or creates one if it's not in `this.streams`
  if (!stream) {
    stream = this._incomingStream(frame.stream);
  }

  // * in case of PUSH_PROMISE, replaces the promised stream id with a new incoming stream
  if (frame.type === 'PUSH_PROMISE') {
    frame.promised_stream = this._incomingStream(frame.promised_stream);
  }

  // * tells the world that there's an incoming frame
  this.emit('receiving', frame);

  // * and writes it to the `stream`'s `upstream`
  stream.upstream.write(frame);

  done();
};

// Settings management
// -------------------

// Settings management initialization:
Connection.prototype._initializeSettingsManagement = function _initializeSettingsManagement(settings) {
  // * Sending the initial settings.
  this._log.info('Sending the first SETTINGS frame as part of the connection header.');
  assert('SETTINGS_MAX_CONCURRENT_STREAMS' in settings);
  assert('SETTINGS_INITIAL_WINDOW_SIZE' in settings);
  this.set(settings);

  // * Checking that the first frame the other endpoint sends is SETTINGS
  this.once('receiving', function(frame) {
    if ((frame.stream === 0) && (frame.type === 'SETTINGS')) {
      this._log.info('Receiving the first SETTINGS frame as part of the connection header.');
    } else {
      this._log.fatal({ frame: frame }, 'Invalid connection header: first frame is not SETTINGS.');
      this.emit('error');
    }
  });

  // * Forwarding SETTINGS frames to the `_receiveSettings` method
  this._control.on('SETTINGS', this._receiveSettings.bind(this));
};

// Handling of incoming SETTINGS frames.
Connection.prototype._receiveSettings = function _receiveSettings(frame) {
  for (var name in frame.settings) {
    this._control.emit(name, frame.settings[name]);
  }
};

// Changing one or more settings value and sending out a SETTINGS frame
Connection.prototype.set = function set(settings) {
  this._control.push({
    type: 'SETTINGS',
    settings: settings
  });
};

// Lifecycle management
// --------------------

// The main responsibilities of lifecycle management code:
//
// * keeping the connection alive by
//   * sending PINGs when the connection is idle
//   * answering PINGs
// * ending the connection

Connection.prototype._initializeLifecycleManagement = function _initializeLifecycleManagement() {
  this._pings = {};
  this._control.on('PING', this._receivePing.bind(this));
  this._control.on('GOAWAY', this._receiveGoaway.bind(this));
  this._lastIncomingStream = 0;
  this.on('stream', function(stream, id) {
    this._lastIncomingStream = id;
  }.bind(this));
};

// Generating a string of length 16 with random hexadecimal digits
Connection.prototype._generatePingId = function _generatePingId() {
  do {
    var id = '';
    for (var i = 0; i < 16; i++) {
      id += Math.floor(Math.random()*16).toString(16);
    }
  } while(id in this._pings);
  return id;
};

// Sending a ping and calling `callback` when the answer arrives
Connection.prototype.ping = function ping(callback) {
  var id = this._generatePingId();
  var data = new Buffer(id, 'hex');
  this._pings[id] = callback;

  this._log.debug({ data: data }, 'Sending PING.');
  this._control.push({
    type: 'PING',
    flags: {
      PONG: false
    },
    data: new Buffer(id, 'hex')
  });
};

// Answering pings
Connection.prototype._receivePing = function _receivePing(frame) {
  if (frame.flags.PONG) {
    var id = frame.data.toString('hex');
    if (id in this._pings) {
      this._log.debug({ data: frame.data }, 'Receiving answer for a PING.');
      this._pings[id]();
      delete this._pings[id];
    } else {
      this._log.warn({ data: frame.data }, 'Unsolicited PING answer.');
    }

  } else {
    this._log.debug({ data: frame.data }, 'Answering PING.');
    this._control.push({
      type: 'PING',
      flags: {
        PONG: true
      },
      data: frame.data
    });
  }
};

// Terminating the connection
Connection.prototype.close = function close(error) {
  this.push({
    type: 'GOAWAY',
    last_stream: this._lastIncomingStream,
    error: error || 'NO_ERROR'
  });
  this.push(null);
};

Connection.prototype._receiveGoaway = function _receiveGoaway(frame) {
  this.push(null);
};

// Flow control
// ------------

Connection.prototype._initializeFlowControl = function _initializeFlowControl() {
  // Turning off flow control for incoming frames (not yet supported).
  this._control.push({
    type: 'WINDOW_UPDATE',
    flags: {
      END_FLOW_CONTROL: true
    },
    window_size: 0
  });

  // Initializing flow control for outgoing frames
  this._window = INITIAL_WINDOW_SIZE;
  this._control.on('WINDOW_UPDATE', this._updateWindow.bind(this));
};

// When a HTTP/2.0 connection is first established, new streams are created with an initial flow
// control window size of 65535 bytes.
var INITIAL_WINDOW_SIZE = 65535;

// A SETTINGS frame can alter the initial flow control window size for all current streams. When the
// value of SETTINGS_INITIAL_WINDOW_SIZE changes, a receiver MUST adjust the size of all stream by
// calling the `setInitialWindowSize` method. The window size has to be modified by the difference
// between the new value and the old value.
Connection.prototype.setInitialWindowSize = function setInitialWindowSize(initialWindowSize) {
  this._window = this._window - this._initialWindowSize + initialWindowSize;
  this._initialWindowSize = initialWindowSize;
};

// Flow control can be disabled for all streams on the connection using the `disableFlowControl`
// method. This may happen when there's a SETTINGS frame received with the
// SETTINGS_FLOW_CONTROL_OPTIONS setting.
Connection.prototype.disableFlowControl = function disableFlowControl() {
  this._window = Infinity;
};

// The `_updateWindow` method gets called every time there's an incoming WINDOW_UPDATE frame. It
// modifies the modifies the flow control window:
//
// * Flow control can be disabled for an individual stream by sending a WINDOW_UPDATE with the
//   END_FLOW_CONTROL flag set. The payload of a WINDOW_UPDATE frame that has the END_FLOW_CONTROL
//   flag set is ignored.
// * A sender that receives a WINDOW_UPDATE frame updates the corresponding window by the amount
//   specified in the frame.
Connection.prototype._updateWindow = function _updateWindow(frame) {
  if (frame.flags.END_FLOW_CONTROL) {
    this.disableFlowControl();
  } else {
    this._window += frame.window_size;
  }
  this.emit('window_update');
};

Connection.prototype._send = function _send(frame) {
  if (frame && (frame.type === 'DATA')) {
    if (frame.data.length > this._window) {
      return null;
    }
    this._window -= frame.data.length;
  }

  return this.push(frame);
};

// TODO list
// ---------
//
// * Stream management
//   * check if the stream initiated by the peer has a stream id with appropriate parity
//   * check for invalid frame types on the control stream
//   * _activateStream:
//     * respect priority when inserting
// * Multiplexing
//   * prioritization
//   * if we are on the flow control limit, it's still possible to send non-DATA frames
 // * Settings management
//   * storing and broadcasting the incoming settings
// * Lifecycle management
//   * implementing connection tear down procedure
// * Flow control
//   * setting the initial window size of streams (based on SETTINGS_INITIAL_WINDOW_SIZE)
