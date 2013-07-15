var Duplex = require('stream').Duplex;

exports.Connection = Connection;

var Stream = require('./stream').Stream;

// Structure of a connection instance:
//
//              |    ^             |    ^
//              v    |             v    |
//         +--------------+   +--------------+
//     +---|   stream1    |---|   stream2    |-----    ....      ---+
//     |   | +----------+ |   | +----------+ |                      |
//     |   | | stream1. | |   | | stream2. | |                      |
//     |   +-| upstream |-+   +-| upstream |-+                      |
//     |     +----------+       +----------+                        |
//     |       |     ^             |    ^                           |
//     |       v     |             v    |                           |
//     |       +-----+-------------+----+----------    ....         |
//     |       ^     |             |    |                           |
//     |       |     v             |    |                           |
//     |   +--------------+        |    |                           |
//     |   |   stream0    |     multiplexing                        |
//     |   |  connection  |     flow control                        |
//     |   |  management  |        |    |                           |
//     |   +--------------+        |    |                           |
//     |                           |    |                           |
//     +------------------------------------------------------------+
//                                 |    ^
//                                 |    |
//                                 v    |

function Connection(firstStreamId, settings, log) {
  Duplex.call(this, { objectMode: true });

  this._next_stream_id = firstStreamId;
  this._settings = settings;
  this._log = log || require('./utils').nolog;

  this._initializeControl();

  this.streams = [this._control];
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
};

// IO
// --

Connection.prototype._read = function read() {
};

Connection.prototype._write = function write(chunk, encoding, callback) {
};
