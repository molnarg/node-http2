var assert = process.env.HTTP2_ASSERT ? require('assert') : function noop() {};

// The Connection class
// ====================

// The Connection class manages HTTP/2 connections. Each instance corresponds to one transport
// stream (TCP stream). It operates by sending and receiving frames and is implemented as a
// [Flow](flow.html) subclass.

var Flow = require('./flow').Flow;

exports.Connection = Connection;

// Public API
// ----------

// * **new Connection(firstStreamId, settings, [log])**: create a new Connection
//
// * **Event: 'error' (type)**: signals a connection level error
//
// * **Event: 'stream' (stream)**: signals that there's an incoming stream
//
// * **createStream(): stream**: initiate a new stream
//
// * **set(settings)**: change the value of one or more settings according to the key-value pairs
//   of `settings`
//
// * **ping(callback)**: send a ping and call callback when the answer arrives
//
// * **close([error])**: close the stream with an error code

// Constructor
// -----------

// The main aspects of managing the connection are:
function Connection(firstStreamId, settings, log) {
  // * initializing the base class
  Flow.call(this, 0);

  // * logging: every method uses the common logger object
  this._log = log.child({ component: 'connection' });

  // * stream management
  this._initializeStreamManagement(firstStreamId);

  // * lifecycle management
  this._initializeLifecycleManagement();

  // * flow control
  this._initializeFlowControl();

  // * settings management
  this._initializeSettingsManagement(settings);

  // * multiplexing
}
Connection.prototype = Object.create(Flow.prototype, { constructor: { value: Connection } });

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
  //   * `_streamIds` is an id -> stream map of the streams that are allowed to receive frames.
  //   * `_streamPriorities` is a priority -> [stream] map of stream that allowed to send frames.
  this._streamIds = [];
  this._streamPriorities = [];

  // * The next outbound stream ID and the last inbound stream id
  this._nextStreamId = firstStreamId;
  this._lastIncomingStream = 0;

  // * Calling `_writeControlFrame` when there's an incoming stream with 0 as stream ID
  this._streamIds[0] = { upstream: { write: this._writeControlFrame.bind(this) } };

  // * By default, the number of concurrent outbound streams is not limited. The `_streamLimit` can
  //   be set by the SETTINGS_MAX_CONCURRENT_STREAMS setting.
  this._streamCount = 0;
  this._streamLimit = Infinity;
  this.on('RECEIVING_SETTINGS_MAX_CONCURRENT_STREAMS', this._updateStreamLimit);
};

// `_writeControlFrame` is called when there's an incoming frame in the `_control` stream. It
// broadcasts the message by creating an event on it.
Connection.prototype._writeControlFrame = function _writeControlFrame(frame) {
  if ((frame.type === 'SETTINGS') || (frame.type === 'PING') ||
      (frame.type === 'GOAWAY') || (frame.type === 'WINDOW_UPDATE')) {
    this._log.debug({ frame: frame }, 'Receiving connection level frame');
    this.emit(frame.type, frame);
  } else {
    this._log.error({ frame: frame }, 'Invalid connection level frame');
    this.emit('error', 'PROTOCOL_ERROR');
  }
};

// Method to manage the stream slot pool:
Connection.prototype._updateStreamLimit = function _updateStreamLimit(newStreamLimit) {
  this._streamLimit = newStreamLimit;
  this.read(0);
};

Connection.prototype._changeStreamCount = function _changeStreamCount(change) {
  if (change) {
    this._log.trace({ count: this._streamCount, change: change }, 'Changing active stream count.');
    this._streamCount += change;
    this.read(0);
  }
};

// Creating a new *inbound or outbound* stream with the given `id` (which is undefined in case of
// an outbound stream) consists of three steps:
//
// 1. var stream = new Stream(this._log);
// 2. this._allocateId(stream, id);
// 2. this._allocatePriority(stream);

// Allocating an ID to a stream
Connection.prototype._allocateId = function _allocateId(stream, id) {
  // * initiated stream without definite ID
  if (id === undefined) {
    id = this._nextStreamId;
    this._nextStreamId += 2;
  }

  // * incoming stream with a legitim ID (larger than any previous and different parity than ours)
  else if ((id > this._lastIncomingStream) && ((id - this._nextStreamId) % 2 !== 0)) {
    this._lastIncomingStream = id;
  }

  // * incoming stream with invalid ID
  else {
    this._log.error({ stream_id: id, lastIncomingStream: this._lastIncomingStream },
                    'Invalid incoming stream ID.');
    this.emit('error', 'PROTOCOL_ERROR');
    return undefined;
  }

  assert(!(id in this._streamIds));

  // * adding to `this._streamIds`
  this._log.trace({ s: stream, stream_id: id }, 'Allocation ID for stream.');
  this._streamIds[id] = stream;
  this.emit('new_stream', stream, id);

  return id;
};

// Allocating a priority to a stream, and managing priority changes
Connection.prototype._allocatePriority = function _allocatePriority(stream) {
  this._log.trace({ s: stream }, 'Allocation priority for stream.');
  this._insert(stream, stream._priority);
  stream.on('priority', this._reprioritize.bind(this, stream));
  stream.upstream.on('readable', this.read.bind(this, 0));
  this.read(0);
};

Connection.prototype._insert = function _insert(stream, priority) {
  if (priority in this._streamPriorities) {
    this._streamPriorities[priority].push(stream);
  } else {
    this._streamPriorities[priority] = [stream];
  }
};

Connection.prototype._reprioritize = function _reprioritize(stream, priority) {
  var bucket = this._streamPriorities[stream._priority];
  var index = bucket.indexOf(stream);
  assert(index !== -1);
  bucket.splice(index, 1);
  if (bucket.length === 0) {
    delete this._streamPriorities[stream._priority];
  }

  this._insert(stream, priority);
};

// Creating an *inbound* stream with the given ID. It is called when there's an incoming frame to
// a previously nonexistent stream.
Connection.prototype._createIncomingStream = function _createIncomingStream(id) {
  this._log.debug({ stream_id: id }, 'New incoming stream.');

  var stream = new Stream(this._log);
  this._allocateId(stream, id);
  this._allocatePriority(stream);
  this.emit('stream', stream, id);

  return stream;
};

// Creating an *outbound* stream
Connection.prototype.createStream = function createStream() {
  this._log.trace('Creating new outbound stream.');

  // * Receiving is enabled immediately, and an ID gets assigned to the stream
  var stream = new Stream(this._log);
  this._allocatePriority(stream);

  return stream;
};

// Multiplexing
// ------------

// The `_send` method is a virtual method of the [Flow class](flow.html) that has to be implemented
// by child classes. It reads frames from streams and pushes them to the output buffer.
Connection.prototype._send = function _send() {
  this._log.trace('Starting forwarding frames from streams.');

  // * Looping through priority `bucket`s in priority order.
priority_loop:
  for (var priority in this._streamPriorities) {
    var bucket = this._streamPriorities[priority].slice();

    // * Forwarding frames from buckets with round-robin scheduling.
    //   1. pulling out frame
    //   2. if there's no frame, remove this stream from `buckets`
    //   3. if forwarding this frame would make `streamCount` greater than `streamLimit`, remove
    //      this stream
    //   4. assigning an ID to the frame (allocating an ID to the stream if there isn't already)
    //   5. if forwarding a PUSH_PROMISE, allocate ID to the promised stream
    //   6. forwarding the frame, changing `streamCount` as appropriate
    //   7. stepping to the next stream if there's still more frame needed in the output buffer
    var index = 0;
    while (bucket.length > 0) {
      index = index % bucket.length;
      var stream = bucket[index];
      var frame = stream.upstream.read();

      if (!frame) {
        bucket.splice(index, 1);
      }

      else if (((this._window === 0) && (frame.type === 'DATA')) ||
               (this._streamCount + frame.count_change > this._streamLimit)) {
        stream.upstream.unshift(frame);
        bucket.splice(index, 1);
      }

      else {
        var id = this._streamIds.indexOf(stream);
        if (id === -1) {
          frame.stream = this._allocateId(stream);
        } else {
          frame.stream = id;
        }

        if (frame.type === 'PUSH_PROMISE') {
          this._allocatePriority(frame.promised_stream);
          frame.promised_stream = this._allocateId(frame.promised_stream);
        }

        this._log.trace({ s: stream, frame: frame }, 'Trying to forward outgoing frame');
        var remainder = null;
        var moreNeeded = this._push(frame, function(remainderFrame) {
          stream.upstream.unshift(remainder = remainderFrame);
        });
        if (!remainder) {
          this._changeStreamCount(frame.count_change);
        }

        if (moreNeeded === null) {
          bucket.splice(index, 1);
        } else if (moreNeeded === false) {
          break priority_loop;
        } else {
          index += 1;
        }
      }
    }
  }

  this._log.trace({ moreNeeded: moreNeeded }, 'Stopping forwarding frames from streams.');
};

// The `_receive` method is another virtual method of the [Flow class](flow.html) that has to be
// implemented by child classes. It forwards the given frame to the appropriate stream:
Connection.prototype._receive = function _receive(frame, done) {
  this._log.trace({ frame: frame }, 'Forwarding incoming frame');

  // * gets the appropriate stream from the stream registry
  var stream = this._streamIds[frame.stream];

  // * or creates one if it's not in `this.streams`
  if (!stream) {
    stream = this._createIncomingStream(frame.stream);
  }

  // * in case of PUSH_PROMISE, replaces the promised stream id with a new incoming stream
  if (frame.type === 'PUSH_PROMISE') {
    frame.promised_stream = this._createIncomingStream(frame.promised_stream);
  }

  frame.count_change = this._changeStreamCount.bind(this);

  // * and writes it to the `stream`'s `upstream`
  stream.upstream.write(frame);

  done();
};

// Settings management
// -------------------

var defaultSettings = {
  SETTINGS_FLOW_CONTROL_OPTIONS: true
};

// Settings management initialization:
Connection.prototype._initializeSettingsManagement = function _initializeSettingsManagement(settings) {
  // * Sending the initial settings.
  this._log.debug('Sending the first SETTINGS frame as part of the connection header.');
  this.set(settings || defaultSettings);

  // * Checking that the first frame the other endpoint sends is SETTINGS
  this.once('receiving', function(frame) {
    if ((frame.stream === 0) && (frame.type === 'SETTINGS')) {
      this._log.debug('Receiving the first SETTINGS frame as part of the connection header.');
    } else {
      this._log.fatal({ frame: frame }, 'Invalid connection header: first frame is not SETTINGS.');
      this.emit('error');
    }
  });

  // * Forwarding SETTINGS frames to the `_receiveSettings` method
  this.on('SETTINGS', this._receiveSettings);
};

// Handling of incoming SETTINGS frames.
Connection.prototype._receiveSettings = function _receiveSettings(frame) {
  for (var name in frame.settings) {
    this.emit('RECEIVING_' + name, frame.settings[name]);
  }
};

// Changing one or more settings value and sending out a SETTINGS frame
Connection.prototype.set = function set(settings) {
  this.push({
    stream: 0,
    type: 'SETTINGS',
    settings: settings
  });
  for (var name in settings) {
    this.emit('SENDING_' + name, settings[name]);
  }
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
  this.on('PING', this._receivePing);
  this.on('GOAWAY', this._receiveGoaway);
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
  this.push({
    stream: 0,
    type: 'PING',
    flags: {
      PONG: false
    },
    data: data
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
    this.push({
      stream: 0,
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
  this._log.info({ error: error }, 'Closing the connection');
  this.push({
    stream: 0,
    type: 'GOAWAY',
    last_stream: this._lastIncomingStream,
    error: error || 'NO_ERROR'
  });
  this.push(null);
};

Connection.prototype._receiveGoaway = function _receiveGoaway(frame) {
  this._log.info({ error: frame.error }, 'Other end closed the connection');
  this.push(null);
};

// Flow control
// ------------

Connection.prototype._initializeFlowControl = function _initializeFlowControl() {
  // Handling of initial window size of individual streams.
  this._initialStreamWindowSize = INITIAL_STREAM_WINDOW_SIZE;
  this.on('new_stream', function(stream) {
    stream.upstream.setInitialWindow(this._initialStreamWindowSize);
    if (this._remoteFlowControlDisabled) {
      stream.upstream.disableRemoteFlowControl();
    }
  });
  this.on('RECEIVING_SETTINGS_INITIAL_WINDOW_SIZE', this._setInitialStreamWindowSize);
  this.on('RECEIVING_SETTINGS_FLOW_CONTROL_OPTIONS', this._setLocalFlowControl);
  this.on('SENDING_SETTINGS_FLOW_CONTROL_OPTIONS', this._setRemoteFlowControl);
  this._streamIds[0].upstream.setInitialWindow = function noop() {};
  this._streamIds[0].upstream.disableRemoteFlowControl = function noop() {};
};

// The initial connection flow control window is 65535 bytes.
var INITIAL_STREAM_WINDOW_SIZE = 65535;

// A SETTINGS frame can alter the initial flow control window size for all current streams. When the
// value of SETTINGS_INITIAL_WINDOW_SIZE changes, a receiver MUST adjust the window size of all
// stream by calling the `setInitialStreamWindowSize` method. The window size has to be modified by
// the difference between the new value and the old value.
Connection.prototype._setInitialStreamWindowSize = function _setInitialStreamWindowSize(size) {
  if ((this._initialStreamWindowSize === Infinity) && (size !== Infinity)) {
    this._log.error('Trying to manipulate initial flow control window size after flow control was turned off.');
    this.emit('error', 'FLOW_CONTROL_ERROR');
  } else {
    this._log.debug({ size: size }, 'Changing stream initial window size.');
    this._initialStreamWindowSize = size;
    this._streamIds.forEach(function(stream) {
      stream.upstream.setInitialWindow(size);
    });
  }
};

// `_setStreamFlowControl()` may be used to disable/enable flow control. In practice, it is just
// for turning off flow control since it can not be turned on.
Connection.prototype._setLocalFlowControl = function _setLocalFlowControl(disable) {
  if (disable) {
    this._increaseWindow(Infinity);
    this._setInitialStreamWindowSize(Infinity);
  } else if (this._initialStreamWindowSize === Infinity) {
    this._log.error('Trying to re-enable flow control after it was turned off.');
    this.emit('error', 'FLOW_CONTROL_ERROR');
  }
};

Connection.prototype._setRemoteFlowControl = function _setRemoteFlowControl(disable) {
  if (disable) {
    this.disableRemoteFlowControl();
    this._streamIds.forEach(function(stream) {
      stream.upstream.disableRemoteFlowControl();
    });
  } else if (this._remoteFlowControlDisabled) {
    this._log.error('Trying to re-enable flow control after it was turned off.');
    throw new Error('Trying to re-enable flow control after it was turned off.');
  }
};
