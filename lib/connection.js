var utils  = require('./utils');
var Stream = require('./stream').Stream;
var Duplex = require('stream').Duplex;

exports.Connection = Connection;

// Structure of a connection instance:
//
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

function Connection(firstStreamId, settings, log) {
  Duplex.call(this, { objectMode: true });

  this._next_stream_id = firstStreamId;
  this._settings = settings;
  this._log = log || utils.nolog;

  this.streams = [];

  this._initializeControl();

  this._initializeFlowControl();
}
Connection.prototype = Object.create(Duplex.prototype, { constructor: { value: Connection } });

// Management
// ----------

Connection.prototype.createStream = function createStream() {
  var id = this._next_stream_id;
  this._next_stream_id += 2;
};

// Control
// -------

Connection.prototype._initializeControl = function _initializeControl() {
  this._control = new Duplex({ objectMode: true });
  this._control._write = this._handleControlMessage.bind(this);
  this._control._read = utils.noop;
  this.streams[0] = { upstream: this._control };

  this._control.push({
    type: 'SETTINGS',
    settings: this._settings
  });
  this.once('receiving', function(frame) {
    if (frame.stream !== 0) {
      this.reset();
    }
  });
};

Connection.prototype._handleControlMessage = function _handleControlMessage(frame, encoding, done) {
  this.emit('control', frame);
  done();
};

// Flow control
// ------------

Connection.prototype._initializeFlowControl = function _initializeFlowControl() {
  this._window = INITIAL_WINDOW_SIZE;
  this.on('control', this._updateWindow);
};

// When a HTTP/2.0 connection is first established, new streams are created with an initial flow
// control window size of 65535 bytes.
var INITIAL_WINDOW_SIZE = 65535;

// A SETTINGS frame can alter the initial flow control window size for all current streams. When the
// value of SETTINGS_INITIAL_WINDOW_SIZE changes, a receiver MUST adjust the size of all stream by
// calling the `setInitialWindowSize` method. The window size has to be modified by the difference
// between the new value and the old value.
Stream.prototype.setInitialWindowSize = function setInitialWindowSize(initialWindowSize) {
  this._window = this._window - this._initialWindowSize + initialWindowSize;
  this._initialWindowSize = initialWindowSize;
};

// Flow control can be disabled for all streams on the connection using the `disableFlowControl`
// method. This may happen when there's a SETTINGS frame received with the
// SETTINGS_FLOW_CONTROL_OPTIONS setting.
Stream.prototype.disableFlowControl = function disableFlowControl() {
  this._window = Infinity;
};

// The `_updateWindow` method gets called every time there's an incoming frame. It filters out
// WINDOW_UPDATE frames, and then modifies the modifies the flow control window:
//
// * Flow control can be disabled for an individual stream by sending a WINDOW_UPDATE with the
//   END_FLOW_CONTROL flag set. The payload of a WINDOW_UPDATE frame that has the END_FLOW_CONTROL
//   flag set is ignored.
// * A sender that receives a WINDOW_UPDATE frame updates the corresponding window by the amount
//   specified in the frame.
Connection.prototype._updateWindow = function _updateWindow(frame) {
  if (frame.type === 'WINDOW_UPDATE') {
    if (frame.flags.END_FLOW_CONTROL) {
      this.disableFlowControl();
    } else {
      this._window += frame.window_size;
    }
    this.emit('window_update');
  }
};

Connection.prototype._send = function _send(frame) {
  if (frame && frame.type === 'DATA') {
    if (frame.data.length > this._window) {
      return null;
    }
    this._window -= frame.data.length;
  }

  return this.push(frame);
};

// Multiplexing
// ------------

Connection.prototype._read = function _read() { // TODO: prioritization
  var more_needed = true, stream, frame;
  for (var id = 0; id < this.streams.length && more_needed; id++) {
    stream = this.streams[id];
    if (stream) {
      while (frame = stream.upstream.read()) {
        frame.stream = id;
        more_needed = this._send(frame);
      }
    }
  }

  // More chunk is needed, but we could not provide more
  if (more_needed === true) {
    this.once('stream_readable', this._read.bind(this));
  }

  // We could not send more because of insufficient flow control window
  else if (more_needed === null) {
    this.once('window_update', this._read.bind(this));
  }
};

Connection.prototype._write = function write(frame, encoding, done) {
  var stream = this.streams[frame.stream];

  if (!stream) {
    stream = new Stream();
    stream.upstream.on('readable', this.emit.bind(this, 'stream_readable'));
    this.streams[frame.stream] = stream;
  }

  this.emit('receiving', frame);

  stream.upstream.write(frame);

  done();
};
