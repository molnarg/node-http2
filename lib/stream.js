var Duplex = require('stream').Duplex;
var utils = require('../lib/utils');

exports.Stream = Stream;

var MAX_HTTP_PAYLOAD_SIZE = 16383; // TODO: this is repeated in multiple files

function Stream(log) {
  Duplex.call(this);
  this._read = function noop() {};

  this._log = log || require('./utils').nolog;

  this._initializeUpstream();

  this._initializeState();

  this._initializeFlowControl();
}

Stream.prototype = Object.create(Duplex.prototype, { constructor: { value: Stream } });

// Managing the stream
// -------------------

Stream.prototype.promise = function promise(headers) {
  this._send({
    type: 'PUSH_PROMISE',
    headers: headers
  });
};

Stream.prototype.open = function open(headers, priority) {
  this._send({
    type: 'HEADERS',
    priority: priority,
    headers: headers
  });
};

Stream.prototype.reset = function reset(error) {
  this._send({
    type: 'RST_STREAM',
    error: error
  });
};

// Managing the upstream connection
// --------------------------------

Stream.prototype._initializeUpstream = function _initializeUpstream() {
  var log = this._log;
  this.upstream = new Duplex({ objectMode: true });
  this.upstream._queue = [];
  this.upstream._read = function noop() {};
  this.upstream._write = function(frame, encoding, done) {
    log.debug({ frame: frame }, 'Receiving frame');
    this.emit('receiving', frame);
    done();
  };
  this._flush_timer = undefined;
  this.on('finish', this._finishing.bind(this));
};

Stream.prototype._flush = function _flush() {
  this._flush_timer = undefined;
  var upstream = this.upstream, log = this._log;
  this.upstream._queue.forEach(function(frame) {
    upstream.emit('sending', frame);
    log.debug({ frame: frame }, 'Sending frame');
    upstream.push(frame);
  });
};

Stream.prototype._send = function _send(frame) {
  frame.flags = frame.flags || {};
  this.upstream._queue.push(frame);
  if (!this._flush_timer) {
    this._flush_timer = setImmediate(this._flush.bind(this));
  }
};

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

Stream.prototype._initializeState = function _initializeState() {
  this.state = 'IDLE';
  this.upstream.on('sending', this._transition.bind(this, true));
  this.upstream.on('receiving', this._transition.bind(this, false));
};

Stream.prototype._setState = function transition(state) {
  if (this.state !== state) {
    this._log.debug({ state: state }, 'State transition');
    this.emit('state', state);
    this.state = state;
  }
};

// `_transition` is called every time there's an incoming or outgoing frame. It manages state
// transitions, and detects stream errors.
Stream.prototype._transition = function transition(sending, frame) {
  var receiving = !sending;
  var error = false;

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
        error = true;
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
      } else if ( sending && frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } else { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
        error = true;
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
        error = true;
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
      } else if (sending) { // TODO: what is valid here?
        error = true;
      }
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
      } else if (receiving) { //  // TODO: what is valid here?
        error = true;
      }
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
      error = true;
      break;
  }
  // TODO: DATA frame handling. Sending is allowed in HALF_CLOSED_REMOTE and OPEN?

  if (error) {
    if (sending) {
      this._log.error({ frame: frame, state: this.state }, 'Stream error: sending illegal frame.');
      throw new Error('Sending illegal frame (' + frame.type + ') in ' + this.state + ' state.');
    } else {
      this._log.error({ frame: frame, state: this.state }, 'Stream error: received illegal frame.');
      this.emit('error', 'PROTOCOL_ERROR');
    }
  }
};

// [Flow control](http://tools.ietf.org/id/draft-unicorn-httpbis-http2-01.html#rfc.section.6.9)
// --------------

// Flow control in HTTP/2.0 is implemented using a window kept by each sender on every stream.
// The flow control window is a simple integer value that indicates how many bytes of data the
// sender is permitted to transmit. Two flow control windows are applicable; the stream flow control
// window and the connection flow control window.
Stream.prototype._initializeFlowControl = function _initializeFlowControl() {
  var self = this;
  this.window = INITIAL_WINDOW_SIZE;
  this.upstream.on('receiving', function(frame) {
    if (frame.type === 'WINDOW_UPDATE') {
      self._updateWindow(frame);
    }
  });
};

// When a HTTP/2.0 connection is first established, new streams are created with an initial flow
// control window size of 65535 bytes.
var INITIAL_WINDOW_SIZE = 65535;

// A SETTINGS frame can alter the initial flow control window size for all current streams. When the
// value of SETTINGS_INITIAL_WINDOW_SIZE changes, a receiver MUST adjust the size of all stream flow
// control windows that it maintains by the difference between the new value and the old value.
Stream.prototype.setInitialWindowSize = function setInitialWindowSize(initialWindowSize) {
  this.window = this.window - this._initialWindowSize + initialWindowSize;
  this._initialWindowSize = initialWindowSize;
};

// Flow control can be disabled for all streams on the connection using the
// SETTINGS_FLOW_CONTROL_OPTIONS setting.
Stream.prototype.disableFlowControl = function disableFlowControl() {
  this.window = Infinity;
};

// A sender that receives a WINDOW_UPDATE frame updates the corresponding window by the amount
// specified in the frame.
//
// Flow control can be disabled for an individual stream by sending a WINDOW_UPDATE with the
// END_FLOW_CONTROL flag set. The payload of a WINDOW_UPDATE frame that has the END_FLOW_CONTROL
// flag set is ignored.
Stream.prototype._updateWindow = function _received(frame) {
  if (frame.flags.END_FLOW_CONTROL) {
    this.disableFlowControl();
  } else {
    this.window += frame.window_size;
  }
  this.emit('window_update');
};

// After sending a flow controlled frame, the sender reduces the space available in both windows by
// the length of the transmitted frame. For flow control calculations, the 8 byte frame header is
// not counted.
Stream.prototype._write = function _write(buffer, encoding, done) {
  var chunks = utils.cut(buffer, MAX_HTTP_PAYLOAD_SIZE);
  var sent = 0;

  while (chunks.length > 0 && chunks[0].length <= this.window) {
    var chunk = chunks.shift();
    sent += chunk.length;
    this.window -= chunk.length;
    this._send({
      type: 'DATA',
      flags: {},
      data: chunk
    });
  }

  if (chunks.length === 0) {
    done();
  } else {
    this.once('window_update', this._write.bind(this, buffer.slice(sent), encoding, done));
  }
};
