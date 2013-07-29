var assert  = require('assert');
var utils   = require('./utils');
var logging = require('./logging');

var MAX_HTTP_PAYLOAD_SIZE = 16383; // TODO: this is repeated in multiple files

// Stream is a [Duplex stream](http://nodejs.org/api/stream.html#stream_class_stream_duplex)
// subclass that implements the [HTTP/2 Stream](http://http2.github.io/http2-spec/#rfc.section.3.4)
// concept.

var Duplex = require('stream').Duplex;

exports.Stream = Stream;

// The main aspects of managing the stream are:
function Stream(log) {
  Duplex.call(this);

  // * every method uses the common logger object
  this._log = (log || logging.root).child({ component: 'stream' });

  // * sending and receiving frames to/from the upstream connection
  this._initializeUpstream();

  // * receiving and sending stream management commands
  this._initializeManagement();

  // * maintaining the state of the stream (idle, open, closed, etc.) and error detection
  this._initializeState();

  // * flow control, which includes forwarding data from/to the user on the Duplex stream interface
  // (`write()`, `end()`, `pipe()`)
  this._initializeFlowControl();
}

Stream.prototype = Object.create(Duplex.prototype, { constructor: { value: Stream } });

// Managing the stream
// -------------------

// PUSH_PROMISE and HEADERS are forwarded to the user through events. When error happens, we first
// close the stream.
Stream.prototype._initializeManagement = function _initializeManagement() {
  this.upstream.on('receiving', function(frame) {
    if (frame.type === 'PUSH_PROMISE') {
      this.emit('promise', frame.headers);
    } else if (frame.type === 'HEADERS') {
      this.priority = frame.priority;
      this.emit('headers', frame.headers);
    }
  }.bind(this));
  this.on('error', function() {
    this.push(null);
  });
};

// For sending management frames, the `this._send(frame)` method is used. It notifies the state
// management code about the sent frames (using the 'sending' event) so we don't have to manage
// state transitions here.
Stream.prototype.promise = function _promise(promised_stream, headers) {
  assert(promised_stream.state === 'IDLE');
  promised_stream.emit('promise_initiated');
  this._send({
    type: 'PUSH_PROMISE',
    promised_stream: promised_stream,
    headers: headers
  });
};

Stream.prototype.open = function open(headers, priority) {
  this._send({
    type: 'HEADERS',
    priority: priority,
    headers: headers
  });
  this.priority = priority;
};

Stream.prototype.reset = function reset(error) {
  this._send({
    type: 'RST_STREAM',
    error: error
  });
};

// Managing the upstream connection
// --------------------------------

// The incoming and the generated outgoing frames are received/transmitted on the `this.upsteam`
// Duplex stream which operates in [object mode][1]. The [Connection](connection.html) object
// instantiating the stream will read and write frames to/from it.
// [1]: http://nodejs.org/api/stream.html#stream_new_stream_readable_options
Stream.prototype._initializeUpstream = function _initializeUpstream() {
  this._flush_timer = undefined;
  this.on('finish', this._finishing.bind(this));

  this.upstream = new Duplex({ objectMode: true });
  this.upstream._queue = [];
  this.upstream._read = utils.noop;

  // When there's an incoming frame, we let the world know this by emitting a 'receiving' event.
  var log = this._log;
  this.upstream._write = function(frame, encoding, done) {
    log.debug({ frame: frame }, 'Receiving frame');
    this.emit('receiving', frame);
    done();
  };
};

// Frames can be sent upstream using the `_send` method. The frames to be sent are put into the
// `upstream._queue` first, and are flushed immediately on the beginning of the next turn.
Stream.prototype._send = function _send(frame) {
  frame.flags = frame.flags || {};
  this.upstream._queue.push(frame);
  if (!this._flush_timer) {
    this._flush_timer = setImmediate(this._flush.bind(this));
  }
};

Stream.prototype._flush = function _flush() {
  var frame;
  while(frame = this.upstream._queue.shift()) {
    this.upstream.emit('sending', frame);
    this._log.debug({ frame: frame }, 'Sending frame');
    this.upstream.push(frame);
  }
  this._flush_timer = undefined;
};

// The reason for using an output queue is this. When the stream is finishing (the user calls
// `end()` on it), then we have to set the `END_STREAM` flag on the last object.
//
// If there's no frame in the queue, then we create a 0 length DATA frame. We could do this
// all the time, but putting the flag on an existing frame is a nice optimization.
var empty_buffer = new Buffer(0);
Stream.prototype._finishing = function _finishing() {
  var length = this.upstream._queue.length;
  if (length === 0) {
    this._send({
      type: 'DATA',
      flags: { END_STREAM: true },
      data: empty_buffer
    });
  } else {
    var last_frame = this.upstream._queue[length - 1];
    last_frame.flags.END_STREAM = true;
  }
};

// [Stream States](http://tools.ietf.org/id/draft-unicorn-httpbis-http2-01.html#StreamStates)
// ----------------
//
//                           +--------+
//                     PP    |        |    PP
//                  ,--------|  idle  |--------.
//                 /         |        |         \
//                v          +--------+          v
//         +----------+          |           +----------+
//         |          |          | H         |          |
//     ,---| reserved |          |           | reserved |---.
//     |   | (local)  |          v           | (remote) |   |
//     |   +----------+      +--------+      +----------+   |
//     |      |          ES  |        |  ES          |      |
//     |      | H    ,-------|  open  |-------.      | H    |
//     |      |     /        |        |        \     |      |
//     |      v    v         +--------+         v    v      |
//     |   +----------+          |           +----------+   |
//     |   |   half   |          |           |   half   |   |
//     |   |  closed  |          | R         |  closed  |   |
//     |   | (remote) |          |           | (local)  |   |
//     |   +----------+          |           +----------+   |
//     |        |                v                 |        |
//     |        |  ES / R    +--------+  ES / R    |        |
//     |        `----------->|        |<-----------'        |
//     |  R                  | closed |                  R  |
//     `-------------------->|        |<--------------------'
//                           +--------+

// Streams begin in the IDLE state and transitions happen when there's an incoming or outgoing frame
Stream.prototype._initializeState = function _initializeState() {
  this.state = 'IDLE';
  this.upstream.on('sending', this._transition.bind(this, true));
  this.upstream.on('receiving', this._transition.bind(this, false));
};

// Only `_setState` should change `this.state` directly. It also logs the state change and notifies
// interested parties using the 'state', 'active' and 'inactive' event.
var ACTIVE_STATES = ['HALF_CLOSED_LOCAL', 'HALF_CLOSED_REMOTE', 'OPEN'];

Stream.prototype._setState = function transition(state) {
  if (this.state !== state) {
    this._log.debug({ from: this.state, to: state }, 'State transition');

    var was_active = (ACTIVE_STATES.indexOf(this.state) !== -1);
    var is_active = (ACTIVE_STATES.indexOf(state) !== -1);
    this.state = state;

    this.emit('state', state);
    if (!was_active && is_active) {
      this.emit('active');
    } else if (was_active && !is_active) {
      this.emit('inactive');
    }
  }
};

// `_transition` is called every time there's an incoming or outgoing frame. It manages state
// transitions, and detects stream errors. A stream error is always caused by a frame that is not
// allowed in the current state.
Stream.prototype._transition = function transition(sending, frame) {
  var receiving = !sending;
  var error = undefined;

  switch (this.state) {
    // All streams start in the **idle** state. In this state, no frames have been exchanged.
    //
    // * Sending or receiving a HEADERS frame causes the stream to become "open".
    // * Sending a PUSH_PROMISE frame marks the associated stream for later use. The stream state
    //   for the reserved stream transitions to "reserved (local)".
    // * Receiving a PUSH_PROMISE frame marks the associated stream as reserved by the remote peer.
    //   The state of the stream becomes "reserved (remote)".
    //
    // When the HEADERS frame contains the END_STREAM flags, then two state transitions happen.
    case 'IDLE':
      if (frame.type === 'HEADERS') {
        this._setState('OPEN');
        if (frame.flags.END_STREAM) {
          this._setState(sending ? 'HALF_CLOSED_LOCAL' : 'HALF_CLOSED_REMOTE');
        }
      } else if (frame.type === 'PUSH_PROMISE') {
        this._setState(sending ? 'RESERVED_LOCAL' : 'RESERVED_REMOTE');
      } else { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
        error = 'PROTOCOL_ERROR';
      }
      break;

    // A stream in the **reserved (local)** state is one that has been promised by sending a
    // PUSH_PROMISE frame.
    //
    // * The endpoint can send a HEADERS frame. This causes the stream to open in a "half closed
    //   (remote)" state.
    // * Either endpoint can send a RST_STREAM frame to cause the stream to become "closed". This
    //   releases the stream reservation.
    // * An endpoint MUST NOT send any other type of frame in this state.
    case 'RESERVED_LOCAL':
      if (sending && frame.type === 'HEADERS') {
        this._setState('HALF_CLOSED_REMOTE');
      } else if (sending && frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } else { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
        error = 'PROTOCOL_ERROR';
      }
      break;

    // A stream in the **reserved (remote)** state has been reserved by a remote peer.
    //
    // * Either endpoint can send a RST_STREAM frame to cause the stream to become "closed". This
    //   releases the stream reservation.
    // * Receiving a HEADERS frame causes the stream to transition to "half closed (local)".
    // * Receiving any other type of frame MUST be treated as a stream error of type PROTOCOL_ERROR.
    case 'RESERVED_REMOTE':
      if (frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } else if (receiving && frame.type === 'HEADERS') {
        this._setState('HALF_CLOSED_LOCAL');
      } else {
        error = 'PROTOCOL_ERROR';
      }
      break;

    // The **open** state is where both peers can send frames. In this state, sending peers observe
    // advertised stream level flow control limits.
    //
    // * From this state either endpoint can send a frame with a END_STREAM flag set, which causes
    //   the stream to transition into one of the "half closed" states: an endpoint sending a
    //   END_STREAM flag causes the stream state to become "half closed (local)"; an endpoint
    //   receiving a END_STREAM flag causes the stream state to become "half closed (remote)".
    // * Either endpoint can send a RST_STREAM frame from this state, causing it to transition
    //   immediately to "closed".
    case 'OPEN':
      if (frame.flags.END_STREAM) {
        this._setState(sending ? 'HALF_CLOSED_LOCAL' : 'HALF_CLOSED_REMOTE');
      } else if (frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } // Anything else is OK
      break;

    // A stream that is **half closed (local)** cannot be used for sending frames.
    //
    // * A stream transitions from this state to "closed" when a frame that contains a END_STREAM
    //   flag is received, or when either peer sends a RST_STREAM frame.
    case 'HALF_CLOSED_LOCAL':
      if (frame.type === 'RST_STREAM' || (receiving && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (sending) {
        error = 'PROTOCOL_ERROR';
      } // Receiving anything is OK
      break;

    // A stream that is **half closed (remote)** is no longer being used by the peer to send frames.
    // In this state, an endpoint is no longer obligated to maintain a receiver flow control window
    // if it performs flow control.
    //
    // * If an endpoint receives additional frames for a stream that is in this state it MUST
    //   respond with a stream error of type STREAM_CLOSED.
    // * A stream can transition from this state to "closed" by sending a frame that contains a
    //   END_STREAM flag, or when either peer sends a RST_STREAM frame.
    case 'HALF_CLOSED_REMOTE':
      if (frame.type === 'RST_STREAM' || (sending && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (receiving) {
        error = 'PROTOCOL_ERROR';
      } // Sending anything is OK
      break;

    // The **closed** state is the terminal state.
    //
    // * An endpoint MUST NOT send frames on a closed stream. An endpoint that receives a frame
    //   after receiving a RST_STREAM or a frame containing a END_STREAM flag on that stream MUST
    //   treat that as a stream error of type STREAM_CLOSED.
    // * If this state is reached as a result of sending a RST_STREAM frame, the peer that receives
    //   the RST_STREAM might have already sent - or enqueued for sending - frames on the stream
    //   that cannot be withdrawn. An endpoint that sends a RST_STREAM frame MUST ignore frames that
    //   it receives on closed streams after it has sent a RST_STREAM frame. An endpoint MAY choose
    //   to limit the period over which it ignores frames and treat frames that arrive after this
    //   time as being in error.
    // * An endpoint might receive a PUSH_PROMISE frame after it sends RST_STREAM. PUSH_PROMISE
    //   causes a stream to become "reserved". If promised streams are not desired, a RST_STREAM
    //   can be used to close any of those streams.
    case 'CLOSED':
      if (receiving && frame.type === 'PUSH_PROMISE') {
        this._setState('RESERVED_REMOTE');
      } else if (!(sending && frame.type === 'RST_STREAM')) {
        error = 'PROTOCOL_ERROR';
      } // TODO: act based on the reason for termination.
      break;
  }

  // Common error handling.
  if (error) {
    var info = { error: error, frame: frame, state: this.state };

    // * When sending something invalid, throwing an exception, since it is probably a bug.
    if (sending) {
      this._log.error(info, 'Stream error: sending illegal frame.');
      throw new Error('Sending illegal frame (' + frame.type + ') in ' + this.state + ' state.');
    }

    // * When receiving something invalid, sending an RST_STREAM using the `reset` method.
    //   This will automatically cause a transition to the CLOSED state.
    else {
      this._log.error(info, 'Stream error: received illegal frame.');
      this.state = 'CLOSED';
      this.reset(error);
    }
  }
};

// [Flow control](http://tools.ietf.org/id/draft-unicorn-httpbis-http2-01.html#rfc.section.6.9)
// --------------

// Flow control in HTTP/2.0 is implemented using a window kept by each sender on every stream.
// The flow control window is a simple integer value that indicates how many bytes of data the
// sender is permitted to transmit. Two flow control windows are applicable; the stream flow control
// window and the connection flow control window. The stream only manages the flow control `window`.
Stream.prototype._initializeFlowControl = function _initializeFlowControl() {
  this._read = utils.noop;
  this.upstream.on('receiving', this._receiveData.bind(this));

  this._window = INITIAL_WINDOW_SIZE;
  this.upstream.on('receiving', this._updateWindow.bind(this));
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
Stream.prototype._updateWindow = function _updateWindow(frame) {
  if (frame.type === 'WINDOW_UPDATE') {
    if (frame.flags.END_FLOW_CONTROL) {
      this.disableFlowControl();
    } else {
      this._window += frame.window_size;
    }
    this.emit('window_update');
  }
};

// When the user wants to write a buffer into the stream
Stream.prototype._write = function _write(buffer, encoding, done) {
  // * The incoming buffer is cut into pieces that are not larger than `MAX_HTTP_PAYLOAD_SIZE`
  var chunks = utils.cut(buffer, MAX_HTTP_PAYLOAD_SIZE);
  var sent = 0;

  // * Chunks are wrapped in DATA frames and sent out until all of them are sent or the flow control
  //   `window` is not enough to send a chunk
  while (chunks.length > 0 && chunks[0].length <= this._window) {
    var chunk = chunks.shift();
    sent += chunk.length;
    this._send({
      type: 'DATA',
      flags: {},
      data: chunk
    });

    // * After sending a flow controlled frame, the sender reduces the space available the window by
    //   the length of the transmitted frame. For flow control calculations, the 8 byte frame header
    //   is not counted.
    this._window -= chunk.length;
  }

  // * If all of the chunks are sent, we are done
  if (chunks.length === 0) {
    done();
  }

  // * Otherwise the process has to continue when a window_update occurs. It is guaranteed by
  //   the Duplex stream class, that there will be no more calls to `_write` until we are done
  else {
    this.once('window_update', this._write.bind(this, buffer.slice(sent), encoding, done));
  }
};

Stream.prototype._receiveData = function _receiveData(frame) {
  if (frame.type === 'DATA') {
    this.push(frame.data);
  }

  if (frame.flags.END_STREAM) {
    this.push(null);
  }
};
