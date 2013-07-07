var EventEmitter = require('events').EventEmitter;
var Transform = require('stream').Transform;
var utils = require('../lib/utils');

exports.Stream = Stream;

function Stream(log) {
  EventEmitter.call(this);

  this.log = log || require('./utils').nolog;

  // All streams start in the "idle" state. In this state, no frames have been exchanged.
  this.state = 'IDLE';

  this.upstream = new Transform({ objectMode: true });
  this.upstream._transform = this._writeData.bind(this);
  this.upstream.stream = this;
  this.upstream.writeHead = this.open.bind(this);
  this.upstream.writePromise = this.promise.bind(this);

  this.downstream = new Transform({ objectMode: true });
  this.downstream._transform = this._readData.bind(this);
  this.downstream.stream = this;
}

Stream.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Stream } });


// [Stream States](http://tools.ietf.org/id/draft-unicorn-httpbis-http2-01.html#StreamStates)
// ===============
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

Stream.prototype._setState = function transition(state) {
  if (this.state !== state) {
    this.log.debug({ state: state }, 'State transition');
    this.emit('state', state);
    this.state = state;
  }
};

Stream.prototype._transition = function transition(frame, sending) {
  var receiving = !sending;

  switch (this.state) {
    // All streams start in the "idle" state. In this state, no frames have been exchanged.
    //
    // * Sending or receiving a HEADERS frame causes the stream to become "open".
    // * Sending a PUSH_PROMISE frame marks the associated stream for later use. The stream state
    //   for the reserved stream transitions to "reserved (local)".
    // * Receiving a PUSH_PROMISE frame marks the associated stream as reserved by the remote peer.
    //   The state of the stream becomes "reserved (remote)".
    case 'IDLE':
      if (frame.type === 'HEADERS') {
        this._setState('OPEN');
      } else if (frame.type === 'PUSH_PROMISE') {
        this._setState(sending ? 'RESERVED_LOCAL' : 'RESERVED_REMOTE');
      } else {
        if (sending) {
          throw new Error('Sending illegal frame (' + frame.type + ') in IDLE state.');
        } else { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
          this.emit('error');
        }
      }
      break;

    // A stream in the "reserved (local)" state is one that has been promised by sending a
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
      } else {
        if (sending) {
          throw new Error('Sending illegal frame (' + frame.type + ') in RESERVED_LOCAL state');
        } else { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
          this.emit('error', 'PROTOCOL_ERROR');
        }
      }
      break;

    // A stream in the "reserved (remote)" state has been reserved by a remote peer.
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
        if (sending) {
          throw new Error('Sending illegal frame (' + frame.type + ') in RESERVED_REMOTE state');
        } else {
          this.emit('error', 'PROTOCOL_ERROR'); // TODO: Error handling, logging
        }
      }
      break;

    // The "open" state is where both peers can send frames. In this state, sending peers observe
    // advertised stream level flow control limits.
    //
    // * From this state either endpoint can send a frame with a END_STREAM flag set, which causes
    //   the stream to transition into one of the "half closed" states: an endpoint sending a
    //   END_STREAM flag causes the stream state to become "half closed (local)"; an endpoint
    //   receiving a END_STREAM flag causes the stream state to become "half closed (remote)".
    // * Either endpoint can send a RST_STREAM frame from this state, causing it to transition
    //   immediately to "closed".
    case 'OPEN':
      if (frame.flags && frame.flags.END_STREAM) {
        this._setState(sending ? 'HALF_CLOSED_LOCAL' : 'HALF_CLOSED_REMOTE');
      } else if (frame.type === 'RST_STREAM') {
        this._setState('CLOSED');
      } else if (frame.type !== 'DATA') { // TODO: Not well defined. https://github.com/http2/http2-spec/issues/165
        if (sending) {
          throw new Error('Sending illegal frame (' + frame.type + ') in OPEN state');
        } else {
          this.emit('error', 'PROTOCOL_ERROR'); // TODO: Error handling, logging
        }
      }
      break;

    // A stream that is "half closed (local)" cannot be used for sending frames.
    //
    // * A stream transitions from this state to "closed" when a frame that contains a END_STREAM
    //   flag is received, or when either peer sends a RST_STREAM frame.
    case 'HALF_CLOSED_LOCAL':
      if (frame.type === 'RST_STREAM' || (receiving && frame.flags && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (sending) { // TODO: what is valid here?
        throw new Error('Sending illegal frame (' + frame.type + ') in OPEN state');
      }
      break;

    // A stream that is "half closed (remote)" is no longer being used by the peer to send frames.
    // In this state, an endpoint is no longer obligated to maintain a receiver flow control window
    // if it performs flow control.
    //
    // * If an endpoint receives additional frames for a stream that is in this state it MUST
    //   respond with a stream error of type STREAM_CLOSED.
    // * A stream can transition from this state to "closed" by sending a frame that contains a
    //   END_STREAM flag, or when either peer sends a RST_STREAM frame.
    case 'HALF_CLOSED_REMOTE':
      if (frame.type === 'RST_STREAM' || (sending && frame.flags && frame.flags.END_STREAM)) {
        this._setState('CLOSED');
      } else if (receiving) { //  // TODO: what is valid here?
        this.emit('error', 'PROTOCOL_ERROR'); // TODO: Error handling, logging
      }
      break;

    // The "closed" state is the terminal state.
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
      break;
  }
  // TODO: DATA frame handling. Sending is allowed in HALF_CLOSED_REMOTE and OPEN?
};

var MAX_HTTP_PAYLOAD_SIZE = 16383; // TODO: MAX_HTTP_PAYLOAD_SIZE is repeated in multiple files

Stream.prototype._writeData = function _writeData(buffer, encoding, done) {
  var chunks = utils.cut(buffer, MAX_HTTP_PAYLOAD_SIZE);
  for (var i = 0; i < chunks.length; i++) {
    var frame = {
      type: 'DATA',
      flags: {},
      data: chunks[i]
    };
    this._transition(frame, true);
    this.upstream.push(frame);
  }
  done();
};

Stream.prototype._readData = function _readData(frame, encoding, done) {
  this._transition(frame, false);
};

Stream.prototype.promise = function promise(headers) {

};

Stream.prototype.open = function open(headers) {

};

Stream.prototype.close = function close() {

};

// A stream error is an error related to a specific stream identifier that does not affect
// processing of other streams.
//
// An endpoint that detects a stream error sends a RST_STREAM frame that contains the stream
// identifier of the stream where the error occurred. The RST_STREAM frame includes an error code
// that indicates the type of error.
//
// A RST_STREAM is the last frame that an endpoint can send on a stream. The peer that sends the
// RST_STREAM frame MUST be prepared to receive any frames that were sent or enqueued for sending by
// the remote peer. These frames can be ignored, except where they modify connection state (such as
// the state maintained for header compression).
//
// Normally, an endpoint SHOULD NOT send more than one RST_STREAM frame for any stream. However, an
// endpoint MAY send additional RST_STREAM frames if it receives frames on a closed stream after
// more than a round trip time. This behavior is permitted to deal with misbehaving implementations.
//
// An endpoint MUST NOT send a RST_STREAM in response to an RST_STREAM frame, to avoid looping.

Stream.prototype.reset = function reset(error) {

};
