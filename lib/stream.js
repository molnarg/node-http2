var assert = process.env.HTTP2_ASSERT ? require('assert') : function noop() {};
var logging = require('./logging');

// The Stream class
// ================

// Stream is a [Duplex stream](http://nodejs.org/api/stream.html#stream_class_stream_duplex)
// subclass that implements the [HTTP/2 Stream](http://http2.github.io/http2-spec/#rfc.section.3.4)
// concept. It has two 'sides': one that is used by the user to send/receive data (the `stream`
// object itself) and one that is used by a Connection to read/write frames to/from the other peer
// (`stream.upstream`).

var Duplex = require('stream').Duplex;

exports.Stream = Stream;

// Public API
// ----------

// * **Event: 'headers' (headers)**: signals incoming headers
//
// * **Event: 'promise' (headers, stream)**: signals an incoming push promise
//
// * **Event: 'error' (type)**: signals an error
//
// * **headers(headers, [priority])**: send headers
//
// * **promise(headers, stream)**: promise a stream
//
// * **reset(error)**: reset the stream with an error code
//
// * **upstream**: a [Flow](flow.js) that is used by the parent connection to write/read frames
//   that are to be sent/arrived to/from the peer and are related to this stream.
//
// Headers are always in the [regular node.js header format][1].
// [1]: http://nodejs.org/api/http.html#http_message_headers

// Constructor
// -----------

// The main aspects of managing the stream are:
function Stream(log) {
  Duplex.call(this);

  // * every method uses the common logger object
  this._log = (log || logging.root).child({ component: 'stream' });

  // * receiving and sending stream management commands
  this._initializeManagement();

  // * sending and receiving frames to/from the upstream connection
  this._initializeDataFlow();

  // * maintaining the state of the stream (idle, open, closed, etc.) and error detection
  this._initializeState();
}

Stream.prototype = Object.create(Duplex.prototype, { constructor: { value: Stream } });

// Managing the stream
// -------------------

// PUSH_PROMISE and HEADERS are forwarded to the user through events. When error happens, we first
// close the stream.
Stream.prototype._initializeManagement = function _initializeManagement() {
  this.on('PUSH_PROMISE', function(frame) {
    this.emit('promise', frame.headers, frame.promised_stream);
  });
  this.on('HEADERS', function(frame) {
    this.priority = frame.priority;
    this.emit('headers', frame.headers);
  });
};

// For sending management frames, the `this.upstream.push(frame)` method is used. It notifies the state
// management code about the sent frames (using the 'sending' event) so we don't have to manage
// state transitions here.
Stream.prototype.promise = function promise(stream, headers) {
  stream.emit('promise_initiated');
  this.upstream.push({
    type: 'PUSH_PROMISE',
    promised_stream: stream,
    headers: headers
  });
};

Stream.prototype.headers = function headers(headers, priority) {
  this.upstream.push({
    type: 'HEADERS',
    priority: priority,
    headers: headers
  });
  this.priority = priority;
};

Stream.prototype.reset = function reset(error) {
  this.upstream.push({
    type: 'RST_STREAM',
    error: error
  });
};

// Data flow
// ---------

// The incoming and the generated outgoing frames are received/transmitted on the `this.upsteam`
// [Flow](flow.html). The [Connection](connection.html) object instantiating the stream will read
// and write frames to/from it. The stream itself is a regular [Duplex stream][1], and is used by
// the user to write or read the body of the request.
// [1]: http://nodejs.org/api/stream.html#stream_class_stream_duplex

//     upstream side                  stream                  user side
//
//                    +------------------------------------+
//                    |                                    |
//                    +------------------+                 |
//                    |     upstream     |                 |
//                    |                  |                 |
//                    +--+               |              +--|
//            read()  |  |  _send()      |    _write()  |  |  write(buf)
//     <--------------|B |<--------------|--------------| B|<------------
//                    |  |               |              |  |
//            frames  +--+               |              +--|  buffers
//                    |  |               |              |  |
//     -------------->|B |---------------|------------->| B|------------>
//      write(frame)  |  |  _receive()   |     _read()  |  |  read()
//                    +--+               |              +--|
//                    |                  |                 |
//                    |                  |                 |
//                    +------------------+                 |
//                    |                                    |
//                    +------------------------------------+
//
//     B: input or output buffer

var Flow = require('./flow').Flow;

Stream.prototype._initializeDataFlow = function _initializeDataFlow() {
  this.upstream = new Flow();
  this.upstream._log = this._log;
  this.upstream._send = this._send.bind(this);
  this.upstream._receive = this._receive.bind(this);
  this.upstream.on('sending', this.emit.bind(this, 'sending'));
  this.upstream.on('receiving', this.emit.bind(this, 'receiving'));
  this.upstream.on('error', this.emit.bind(this, 'error'));

  this.on('finish', this._finishing);
};

// The `_receive` method (= `upstream._receive`) gets called when there's an incoming frame.
Stream.prototype._receive = function _receive(frame, ready) {
  var callReady = true;

  // * If it's a DATA frame, then push the payload into the output buffer on the other side.
  //   Call ready when the other side is ready to receive more.
  if (frame.type === 'DATA') {
    var moreNeeded = this.push(frame.data);
    if (!moreNeeded) {
      this._receiveMore = ready;
      callReady = false;
    }
  }

  // * Otherwise it's a control frame. Emit an event to notify interested parties.
  else {
    this.emit(frame.type, frame);
  }

  // * Any frame may signal the end of the stream with the END_STREAM flag
  if (frame.flags.END_STREAM) {
    this.push(null);
  }

  if (callReady) {
    ready();
  }
};

// The `_read` method is called when the user side is ready to receive more data. If there's a
// pending write on the upstream, then call its pending ready callback to receive more frames.
Stream.prototype._read = function _read() {
  if (this._receiveMore) {
    var receiveMore = this._receiveMore;
    delete this._receiveMore;
    receiveMore();
  }
};

// The `write` method gets called when there's a write request from the user.
Stream.prototype._write = function _write(buffer, encoding, ready) {
  // * Chunking is done by the upstream Flow.
  var moreNeeded = this.upstream.push({
    type: 'DATA',
    data: buffer
  });

  // * Call ready when upstream is ready to receive more frames.
  if (moreNeeded) {
    ready();
  } else {
    this._sendMore = ready;
  }
};

// The `_send` (= `upstream._send`) method is called when upstream is ready to receive more frames.
// If there's a pending write on the user side, then call its pending ready callback to receive more
// writes.
Stream.prototype._send = function _send() {
  if (this._sendMore) {
    var sendMore = this._sendMore;
    delete this._sendMore;
    sendMore();
  }
};

// When the stream is finishing (the user calls `end()` on it), then we have to set the `END_STREAM`
// flag on the last frame. If there's no frame in the queue, or if it doesn't support this flag,
// then we create a 0 length DATA frame. We could do this all the time, but putting the flag on an
// existing frame is a nice optimization.
var endFrame = {
  type: 'DATA',
  flags: { END_STREAM: true },
  data: new Buffer(0)
};
Stream.prototype._finishing = function _finishing() {
  delete endFrame.stream;
  var lastFrame = this.upstream.getLastQueuedFrame();
  if (lastFrame && ((lastFrame.type === 'DATA') || (lastFrame.type === 'HEADERS'))) {
    this._log.trace('Marking last frame with END_STREAM flag.');
    lastFrame.flags.END_STREAM = true;
    this._transition(true, endFrame);
  } else {
    this.upstream.push(endFrame);
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
  this.on('sending', this._transition.bind(this, true));
  this.on('receiving', this._transition.bind(this, false));
};

// Only `_setState` should change `this.state` directly. It also logs the state change and notifies
// interested parties using the 'state', 'active' and 'inactive' event.
var ACTIVE_STATES = ['HALF_CLOSED_LOCAL', 'HALF_CLOSED_REMOTE', 'OPEN'];

Stream.prototype._setState = function transition(state) {
  if (this.state !== state) {
    this._log.debug({ from: this.state, to: state }, 'State transition');

    var wasActive = (ACTIVE_STATES.indexOf(this.state) !== -1);
    var isActive = (ACTIVE_STATES.indexOf(state) !== -1);
    this.state = state;

    this.emit('state', state);
    if (!wasActive && isActive) {
      this.emit('active');
    } else if (wasActive && !isActive) {
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
    //
    // When the HEADERS frame contains the END_STREAM flags, then two state transitions happen.
    case 'IDLE':
      if (frame.type === 'HEADERS') {
        this._setState('OPEN');
        if (frame.flags.END_STREAM) {
          this._setState(sending ? 'HALF_CLOSED_LOCAL' : 'HALF_CLOSED_REMOTE');
        }
      } else {
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
    // * An endpoint may receive PRIORITY frame in this state.
    // * An endpoint MUST NOT send any other type of frame in this state.
    case 'RESERVED_LOCAL':
      if (sending && (frame.type === 'HEADERS')) {
        this._setState('HALF_CLOSED_REMOTE');
      } else if (sending && (frame.type === 'RST_STREAM')) {
        this._setState('CLOSED');
      } else if (!(receiving && (frame.type === 'PRIORITY'))) {
        error = 'PROTOCOL_ERROR';
      }
      break;

    // A stream in the **reserved (remote)** state has been reserved by a remote peer.
    //
    // * Either endpoint can send a RST_STREAM frame to cause the stream to become "closed". This
    //   releases the stream reservation.
    // * Receiving a HEADERS frame causes the stream to transition to "half closed (local)".
    // * An endpoint MAY send PRIORITY frames in this state to reprioritize the stream.
    // * Receiving any other type of frame MUST be treated as a stream error of type PROTOCOL_ERROR.
    case 'RESERVED_REMOTE':
      if (frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } else if (receiving && (frame.type === 'HEADERS')) {
        this._setState('HALF_CLOSED_LOCAL');
      } else if (!(sending && (frame.type === 'PRIORITY'))) {
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
    // * An endpoint MAY send or receive PRIORITY frames in this state to reprioritize the stream.
    // * WINDOW_UPDATE can be sent by a peer that has sent a frame bearing the END_STREAM flag.
    case 'HALF_CLOSED_LOCAL':
      if ((frame.type === 'RST_STREAM') || (receiving && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (sending && !(frame.type === 'PRIORITY') && !(frame.type === 'WINDOW_UPDATE')) {
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
    // * An endpoint MAY send or receive PRIORITY frames in this state to reprioritize the stream.
    // * A receiver MAY receive a WINDOW_UPDATE frame on a "half closed (remote)" stream.
    case 'HALF_CLOSED_REMOTE':
      if ((frame.type === 'RST_STREAM') || (sending && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (receiving && !(frame.type === 'PRIORITY') && !(frame.type === 'WINDOW_UPDATE')) {
        error = 'PROTOCOL_ERROR';
      } // Sending anything is OK
      break;

    // The **closed** state is the terminal state.
    //
    // * An endpoint MUST NOT send frames on a closed stream. An endpoint that receives a frame
    //   after receiving a RST_STREAM or a frame containing a END_STREAM flag on that stream MUST
    //   treat that as a stream error of type STREAM_CLOSED.
    // * WINDOW_UPDATE or PRIORITY frames can be received in this state for a short period after a
    //   frame containing an END_STREAM flag is sent.  Until the remote peer receives and processes
    //   the frame bearing the END_STREAM flag, it might send either frame type. Endpoints MUST
    //   ignore WINDOW_UPDATE frames received in this state, though endpoints MAY choose to treat
    //   WINDOW_UPDATE frames that arrive a significant time after sending END_STREAM as a
    //   connection error of type PROTOCOL_ERROR.
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
      if (receiving && (frame.type === 'PUSH_PROMISE')) {
        this._setState('RESERVED_REMOTE');
      } else if (!(sending && (frame.type === 'RST_STREAM')) &&
                 !(receiving && (frame.type === 'WINDOW_UPDATE')) &&
                 !(receiving && (frame.type === 'PRIORITY'))) {
        error = 'PROTOCOL_ERROR';
      } // TODO: act based on the reason for termination.
      break;
  }

  // Sending/receiving a PUSH_PROMISE
  //
  // * Sending a PUSH_PROMISE frame marks the associated stream for later use. The stream state
  //   for the reserved stream transitions to "reserved (local)".
  // * Receiving a PUSH_PROMISE frame marks the associated stream as reserved by the remote peer.
  //   The state of the stream becomes "reserved (remote)".
  if (!error && (frame.type === 'PUSH_PROMISE')) {
    assert(frame.promised_stream.state === 'IDLE', 'Promised stream is in invalid state (' +
                                                   frame.promised_stream.state + ')');
    frame.promised_stream._setState(sending ? 'RESERVED_LOCAL' : 'RESERVED_REMOTE');
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
      this.emit('error', error);
    }
  }
};
