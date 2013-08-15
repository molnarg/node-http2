var assert = process.env.HTTP2_ASSERT ? require('assert') : function noop() {};
var logging = require('./logging');

// The Flow class
// ==============

// Flow is a [Duplex stream][1] subclass which implements HTTP/2 flow control. It is designed to be
// subclassed by [Connection](connection.html) and the `upstream` component of [Stream](stream.html).
// [1]: http://nodejs.org/api/stream.html#stream_class_stream_duplex

var Duplex  = require('stream').Duplex;

exports.Flow = Flow;

// Public API
// ----------

// * **Event: 'error' (type)**: signals an error
//
// * **setInitialWindow(size)**: the initial flow control window size can be changed *any time*
//   ([as described in the standard][1]) using this method
//
// * **disableRemoteFlowControl()**: sends a WINDOW_UPDATE signaling that we don't want flow control
//
// * **disableLocalFlowControl()**: disables flow control for outgoing frames
//
// [1]: http://tools.ietf.org/html/draft-ietf-httpbis-http2-04#section-6.9.2

// API for child classes
// ---------------------

// * **new Flow([flowControlId])**: creating a new flow that will listen for WINDOW_UPDATES frames
//   with the given `flowControlId` (or every update frame if not given)
//
// * **Event: 'receiving' (frame)**: there's an incoming frame
//
// * **Event: 'sending' (frame)**: a frame was added to the output queue
//
// * **_send()**: called when more frames should be pushed. The child class is expected to override
//   this (instead of the `_read` method of the Duplex class).
//
// * **_receive(frame, readyCallback)**: called when there's an incoming frame. The child class is
//   expected to override this (instead of the `_write` method of the Duplex class).
//
// * **push(frame): bool**: schedules `frame` for sending.
//
//   Returns `true` if it needs more frames in the output queue, `false` if the output queue is
//   full, and `null` if did not push the frame into the output queue (instead, it pushed it into
//   the flow control queue).
//
// * **_push(frame, remainderCallback): bool**: like push, but never puts the frame into the
//   flow control queue.
//
//   Instead, it pushes directly into the output queue if possible (according to the flow control
//   window) and calls `remainderCallback` with the remaining non-pushable part of the frame. It is
//   capable of dividing DATA frames into multiple chunks.
//
//   Use this instead of `push` if you always want to have empty flow control queue (but never mix
//   the two).
//
// * **getLastQueuedFrame(): frame**: returns the last frame in output buffers
//
// * **_log**: the Flow class uses the `_log` object of the parent

// Constructor
// -----------

// When a HTTP/2.0 connection is first established, new streams are created with an initial flow
// control window size of 65535 bytes.
var INITIAL_WINDOW_SIZE = 65535;

// `flowControlId` is needed if only specific WINDOW_UPDATEs should be watched.
function Flow(flowControlId) {
  Duplex.call(this, { objectMode: true });

  this._window = this._initialWindow = INITIAL_WINDOW_SIZE;
  this._flowControlId = flowControlId;
  this._queue = [];

  this._ended = false;
  this._received = 0;
  this._remoteFlowControlDisabled = false;
}
Flow.prototype = Object.create(Duplex.prototype, { constructor: { value: Flow } });

// Incoming frames
// ---------------

// `_receive` is called when there's an incoming frame.
Flow.prototype._receive = function _receive(frame, callback) {
  throw new Error('The _receive(frame, callback) method has to be overridden by the child class!');
};

// `_receive` is called by `_write` which in turn is [called by Duplex][1] when someone `write()`s
// to the flow. It emits the 'receiving' event and notifies the window size tracking code if the
// incoming frame is a WINDOW_UPDATE.
// [1]: http://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback_1
Flow.prototype._write = function _write(frame, encoding, callback) {
  this.emit('receiving', frame);

  if (frame.flags.END_STREAM) {
    this._ended = true;
  }

  if ((frame.type === 'DATA') && (frame.data.length > 0) && !this._remoteFlowControlDisabled) {
    this._receive(frame, function() {
      this._received += frame.data.length;
      if (!this._restoreWindowTimer) {
        this._restoreWindowTimer = setImmediate(this._restoreWindow.bind(this));
      }
      callback();
    }.bind(this));
  }

  else {
    this._receive(frame, callback);
  }

  if ((frame.type === 'WINDOW_UPDATE') &&
      ((this._flowControlId === undefined) || (frame.stream === this._flowControlId))) {
    this._updateWindow(frame);
  }
};

// `_restoreWindow` basically acknowledges the DATA frames received since it's last call. It sends
// a WINDOW_UPDATE that restores the flow control window of the remote end.
Flow.prototype._restoreWindow = function _restoreWindow() {
  delete this._restoreWindowTimer;
  if (!this._ended && !this._remoteFlowControlDisabled && (this._received > 0)) {
    this.push({
      type: 'WINDOW_UPDATE',
      stream: this._flowControlId,
      window_size: this._received
    });
    this._received = 0;
  }
};

// Remote flow control is currently disabled by default, but in the future, it may be turned off
// using the `disableRemoteFlowControl` method.
Flow.prototype.disableRemoteFlowControl = function disableRemoteFlowControl() {
  this._remoteFlowControlDisabled = true;
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

//                                         flow
//                +----------------------------------------------------+
//                |                                                    |
//                +--------+  _onWindow   +---------+                  |
//        read()  | output |  Increase()  | flow    |  _send()         |
//     <----------|        |<-------------| control |<-------------    |
//                | buffer |              | buffer  |                  |
//                +--------+              +---------+                  |
//                | input  |                                           |
//     ---------->|        |-------------------------------------->    |
//       write()  | buffer |  _write()                 _receive()      |
//                +--------+                                           |
//                |                                                    |
//                +----------------------------------------------------+

var MAX_HTTP_PAYLOAD_SIZE = 16383; // TODO: this is repeated in multiple files

// `_send` is called when more frames should be pushed to the output buffer.
Flow.prototype._send = function _send() {
  throw new Error('The _send() method has to be overridden by the child class!');
};

// `_send` is called by `_read` which is in turn [called by Duplex][1] when it wants to have more
// items in the output queue. It first check the flow control `_queue` and only calls `_send` if
// there are no items in it (which means that we are not waiting for window update).
// [1]: http://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback_1
Flow.prototype._read = function _read() {
  if (this._queue.length === 0) {
    this._send();
  }
  this._readableState.reading = false;
};

// `_onWindowIncrease` is called when window size increases which means that the peer is ready to
// receive more data. Flushes frames stored in the flow control queue and then triggers a further
// `_read` call if the output buffers are still low on frames.
Flow.prototype._onWindowIncrease = function _onWindowIncrease() {
  var moreNeeded = true, frame;

  var unshiftRemainder = this._queue.unshift.bind(this._queue);
  while (moreNeeded && (frame = this._queue.shift())) {
    moreNeeded = this._push(frame, unshiftRemainder);
  }

  this.read(0); // See http://nodejs.org/api/stream.html#stream_stream_read_0
};

// `_push(frame)` is the low-level version of `push`. Use this instead of `push` if you always want
// to have empty flow control queue (but never mix the two). It pushes `frame` into the output queue
// and decreases the flow control window size. It is capable of splitting DATA frames into smaller
// parts, if the window size is not enough to push the whole frame. It calls `remainderCallback`
// synchronously before returning with the frame it was not able to push to the output queue. The
// remainder may be the whole frame or the remaining part of a DATA frame. The return value is
// similar to `push` except that it returns `null` if it did not push anything to the output queue.
Flow.prototype._push = function _push(frame, remainderCallback) {
  var forwardable, remainder;
  if ((frame === null) || (frame.type !== 'DATA') ||
      ((frame.data.length <= this._window) && (frame.data.length <= MAX_HTTP_PAYLOAD_SIZE))) {
    forwardable = frame;
  }

  else if (this._window <= 0) {
    remainder = frame;
  }

  else {
    var chunkSize = Math.min(this._window, MAX_HTTP_PAYLOAD_SIZE);
    forwardable = {
      stream: frame.stream,
      type: 'DATA',
      data: frame.data.slice(0, chunkSize)
    };

    this._log.trace({ frame: frame, size: frame.data.length, forwardable: chunkSize },
                    'Splitting out forwardable part of a DATA frame.');
    frame.data = frame.data.slice(chunkSize);
    remainder = frame;
  }

  var moreNeeded = null;
  if (forwardable !== undefined) {
    this._log.trace({ frame: forwardable }, 'Pushing frame into the output queue');
    if (forwardable && (forwardable.type === 'DATA') && (this._window !== Infinity)) {
      this._log.trace({ window: this._window, by: forwardable.data.length },
                       'Decreasing flow control window size.');
      this._window -= forwardable.data.length;
      assert(this._window >= 0);
    }
    moreNeeded = Duplex.prototype.push.call(this, forwardable);
  }

  if (remainder !== undefined) {
    remainderCallback(remainder);
  }

  return moreNeeded;
};

// Push `frame` into the flow control queue, or if it's empty, then directly into the output queue
Flow.prototype.push = function push(frame) {
  if (frame === null) {
    this._log.debug('Enqueueing outgoing End Of Stream');
  } else {
    frame.flags = frame.flags || {};
    this._log.debug({ frame: frame }, 'Enqueueing outgoing frame');
    this.emit('sending', frame);
  }

  if (this._queue.length === 0) {
    return this._push(frame, this._queue.push.bind(this._queue));
  } else {
    this._queue.push(frame);
    return null;
  }
};

// `getLastQueuedFrame` returns the last frame in output buffers. This is primarily used by the
// [Stream](stream.html) class to mark the last frame with END_STREAM flag.
Flow.prototype.getLastQueuedFrame = function getLastQueuedFrame() {
  var readableQueue = this._readableState.buffer;
  return this._queue[this._queue.length - 1] || readableQueue[readableQueue.length - 1];
};

// Outgoing frames - managing the window size
// ------------------------------------------

// Flow control window size is manipulated using the `_increaseWindow` method.
//
// * Invoking it with `Infinite` means turning off flow control. Flow control cannot be enabled
//   again once disabled. Any attempt to re-enable flow control MUST be rejected with a
//   FLOW_CONTROL_ERROR error code.
// * A sender MUST NOT allow a flow control window to exceed 2^31 - 1 bytes. The action taken
//   depends on it being a stream or the connection itself.

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

// Flow control for outgoing frames can be disabled by the peer with various methods.
Flow.prototype.disableLocalFlowControl = function disableLocalFlowControl() {
  this._increaseWindow(Infinity);
};
