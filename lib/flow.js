var logging = require('./logging');

// The Flow class
// ==============

var Duplex  = require('stream').Duplex;

exports.Flow = Flow;

// API for child classes
// ---------------------

// Constructor
// -----------

// When a HTTP/2.0 connection is first established, new streams are created with an initial flow
// control window size of 65535 bytes.
var INITIAL_WINDOW_SIZE = 65535;

function Flow(flowControlId) {
  Duplex.call(this, { objectMode: true });

  this._window = this._initialWindow = INITIAL_WINDOW_SIZE;
  this._flowControlId = flowControlId;
  this._queue = [];
}
Flow.prototype = Object.create(Duplex.prototype, { constructor: { value: Flow } });

Flow.prototype.getLastQueuedFrame = function getLastQueuedFrame() {
  var readableQueue = this._readableState.buffer;
  return this._queue[this._queue.length - 1] || readableQueue[readableQueue.length - 1];
};

// Incoming frames
// ---------------

Flow.prototype._receive = function _receive(frame, callback) {
  throw new Error('The _receive(frame, callback) method has to be overridden by the child class!');
};

Flow.prototype._write = function _write(frame, encoding, callback) {
  this._log.trace({ frame: frame }, 'Receiving frame');
  this.emit('receiving', frame);
  this._receive(frame, callback);

  if ((frame.type === 'WINDOW_UPDATE') && (!this._flowControlId || (frame.stream === this._flowControlId))) {
    this._updateWindow(frame);
  }
};

// Remote flow control is currently disabled by default
Flow.prototype.disableRemoteFlowControl = function disableRemoteFlowControl() {
  this.push({
    type: 'WINDOW_UPDATE',
    stream: this._flowControlId,
    flags: {
      END_FLOW_CONTROL: true
    }
  });
};


// Outgoing frames - sending procedure
// -----------------------------------

Flow.prototype._send = function _send() {
  throw new Error('The _send() method has to be overridden by the child class!');
};

// Called when stream wants data to be pushed
Flow.prototype._read = function _read() {
  if (this._queue.length === 0) {
    this._send();
  }
  this._readableState.reading = false;
};

// Called when window size increases (peer wants data to be pushed)
Flow.prototype._onWindowIncrease = function _onWindowIncrease() {
  var moreNeeded = true, frame;

  while (moreNeeded && (frame = this._queue.shift())) {
    if (this._forwardable(frame)) {
      moreNeeded = this._forward(frame);
    } else {
      this._queue.unshift(frame);
      moreNeeded = false;
    }
  }

  this.read(0); // See http://nodejs.org/api/stream.html#stream_stream_read_0
};

Flow.prototype._forwardable = function _forwardable(frame) {
  return (frame === null) || (frame.type !== 'DATA') || (this._window >= frame.data.length);
};

Flow.prototype._forward = function _forward(frame) {
  if ((frame !== null) && (frame.type === 'DATA')) {
    this._log.trace({ window: this._window, by: frame.data.length }, 'Decreasing flow control window size.');
    this._window -= frame.data.length;
  }
  return Duplex.prototype.push.call(this, frame);
};

Flow.prototype.wouldForward = function wouldForward(frame) {
  return (this._queue.length === 0) && (this._forwardable(frame));
};

Flow.prototype.push = function push(frame) {
  if (frame === null) {
    this._log.trace('Enqueueing End Of Stream');
  } else {
    frame.flags = frame.flags || {};
    this._log.trace({ frame: frame }, 'Enqueueing frame');
    this.emit('sending', frame);
  }

  if (this.wouldForward(frame)) {
    return this._forward(frame);
  } else {
    this._queue.push(frame);
    return false;
  }
};

// Outgoing frames - managing the window size
// ------------------------------------------

// Flow control window size is manipulated using the `_increaseWindow` method.
//
// * Invoking it with `Infinite` as argument, it means turning off flow control. Flow control cannot
//   be enabled again once disabled. Any attempt to re-enable flow control MUST be rejected with a
//   FLOW_CONTROL_ERROR error code.
// * A sender MUST NOT allow a flow control window to exceed 2^31 - 1 bytes. If a sender receives a
//   WINDOW_UPDATE that causes a flow control window to exceed this maximum it MUST terminate the
//   connection, as appropriate. For the connection, a GOAWAY frame with a FLOW_CONTROL_ERROR code.

var WINDOW_SIZE_LIMIT = Math.pow(2, 31) - 1;

Flow.prototype._increaseWindow = function _increaseWindow(size) {
  if ((this._window === Infinity) && (size !== Infinity)) {
    this._log.error('Trying to increase flow control window after flow control was turned off.');
    this.emit('error', 'FLOW_CONTROL_ERROR');
  } else {
    this._log.trace({ window: this._window, by: size }, 'Increasing flow control window size.');
    this._window += size;
    if ((this._window !== Infinity) && (this._window > WINDOW_SIZE_LIMIT)) {
      this._log.error('Flow control window grew too large.');
      this.emit('error', 'FLOW_CONTROL_ERROR');
    } else {
      this._onWindowIncrease();
    }
  }
};

// The `_updateWindow` method gets called every time there's an incoming WINDOW_UPDATE frame. It
// modifies the flow control window:
//
// * Flow control can be disabled for an individual stream by sending a WINDOW_UPDATE with the
//   END_FLOW_CONTROL flag set. The payload of a WINDOW_UPDATE frame that has the END_FLOW_CONTROL
//   flag set is ignored.
// * A sender that receives a WINDOW_UPDATE frame updates the corresponding window by the amount
//   specified in the frame.
Flow.prototype._updateWindow = function _updateWindow(frame) {
  this._increaseWindow(frame.flags.END_FLOW_CONTROL ? Infinity : frame.window_size);
};

// A SETTINGS frame can alter the initial flow control window size for all current streams. When the
// value of SETTINGS_INITIAL_WINDOW_SIZE changes, a receiver MUST adjust the size of all stream by
// calling the `setInitialWindow` method. The window size has to be modified by the difference
// between the new value and the old value.
Flow.prototype.setInitialWindow = function setInitialWindow(initialWindow) {
  this._increaseWindow(initialWindow - this._initialWindow);
  this._initialWindow = initialWindow;
};

Flow.prototype.disableLocalFlowControl = function disableLocalFlowControl() {
  this._increaseWindow(Infinity);
};
