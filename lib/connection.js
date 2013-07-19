var utils   = require('./utils');
var logging = require('./logging');
var Stream  = require('./stream').Stream;
var Duplex  = require('stream').Duplex;

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

// Connection
// ----------

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

// Stream management
// -----------------

Connection.prototype._initializeStreamManagement = function _initializeStreamManagement(firstStreamId) {
  this._control = new Duplex({ objectMode: true });
  this._control._write = function(frame, encoding, done) {
    this.emit(frame.type, frame);
    done();
  };
  this._control._read = utils.noop;
  this._control.on('readable', this.emit.bind(this, 'stream_readable'));

  this.streams = [{ upstream: this._control }];
  this._next_stream_id = firstStreamId;
};

Connection.prototype._newStream = function _newStream(id) {
  var stream = new Stream(this._log.child({ stream: id }));
  this._log.trace({ id: id }, 'Adding new stream.');
  this.streams[id] = stream;
  stream.upstream.on('readable', this.emit.bind(this, 'stream_readable'));
  return stream;
};

Connection.prototype.createStream = function createStream() {
  var id = this._next_stream_id;
  this._next_stream_id += 2;
  return this._newStream(id);
};

// Multiplexing
// ------------

Connection.prototype._read = function _read() { // TODO: prioritization
  this._log.trace('Starting forwarding frames from streams.');

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

  if (more_needed === true) {
    this._log.trace('More chunk is needed, but we could not provide more.');
    this.once('stream_readable', this._read.bind(this));
  }

  else if (more_needed === null) {
    this._log.trace('We could not send more because of insufficient flow control window.'); // TODO: push back frame
    this.once('window_update', this._read.bind(this));
  }

  else {
    this._log.trace('No more chunk needed, stopping forwarding.');
  }
};

Connection.prototype._write = function write(frame, encoding, done) {
  var stream = this.streams[frame.stream] || this._newStream(frame.stream);

  this.emit('receiving', frame);

  stream.upstream.write(frame);

  done();
};

// Settings management
// -------------------

Connection.prototype._initializeSettingsManagement = function _initializeSettingsManagement(settings) {
  this._settings = settings;

  this._log.info('Sending the first SETTINGS frame as part of the connection header.');
  this._control.push({
    type: 'SETTINGS',
    settings: this._settings
  });

  this.once('receiving', function(frame) {
    if (frame.stream === 0 && frame.type === 'SETTINGS') {
      this._log.info('Receiving the first SETTINGS frame as part of the connection header.');
    } else {
      this.reset();
    }
  });

  this._control.on('SETTINGS', this._receiveSettings.bind(this));
};

Connection.prototype._receiveSettings = function _receiveSettings(frame) {
};

// Lifecycle management
// --------------------

Connection.prototype._initializeLifecycleManagement = function _initializeLifecycleManagement() {
  this._pings = {};
  this._control.on('PING', this._receivePing.bind(this));
  this._control.on('GOAWAY', this._receiveGoaway.bind(this));
};

Connection.prototype._generatePingId = function _generatePingId() {
  do {
    var id = '';
    for (var i = 0; i < 16; i++) {
      id += Math.floor(Math.random()*16).toString(16);
    }
  } while(!(id in this._pings));
  return id;
};

Connection.prototype.ping = function ping(callback) {
  var id = this._generatePingId();
  var data = new Buffer(id, 'hex');
  this._pings[id] = callback;

  this._log.debug({ data: data }, 'Sending PING.')
  this._control.push({
    type: 'PING',
    flags: {
      PONG: false
    },
    data: new Buffer(id, 'hex')
  });
};

Connection.prototype._receivePing = function _receivePing(frame) {
  if (frame.flags.PONG) {
    var id = frame.data.toString('hex');
    if (id in this._pings) {
      this._log.debug({ data: frame.data }, 'Receiving answer for a PING.');
      this._pings[id]();
      delete this._pings[id];
    } else {
      this._log.warning({ data: frame.data }, 'Unsolicited PING answer.');
    }

  } else {
    this._log.debug({ data: frame.data }, 'Answering PING.')
    this._control.push({
      type: 'PING',
      flags: {
        PONG: true
      },
      data: frame.data
    });
  }
};

Connection.prototype.reset = function reset() {
};

Connection.prototype._receiveGoaway = function _receiveGoaway(frame) {
};

// Flow control
// ------------

Connection.prototype._initializeFlowControl = function _initializeFlowControl() {
  // Turning off flow control for incoming frames (not yet supported):
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
  if (frame && frame.type === 'DATA') {
    if (frame.data.length > this._window) {
      return null;
    }
    this._window -= frame.data.length;
  }

  return this.push(frame);
};
