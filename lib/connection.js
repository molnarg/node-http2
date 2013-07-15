var Duplex = require('stream').Duplex;

exports.Connection = Connection;

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

function Connection(role, settings, initialRequest, initialResponse) {
  Duplex.call(this, { objectMode: true });

  this.role = role; // 'client' or 'server'
  this.next_stream_id = (this.role === 'CLIENT') ? 1 : 2;
}
Connection.prototype = Object.create(Duplex.prototype, { constructor: { value: Connection } });

Connection.prototype.createStream = function createStream() {
  var id = this.next_stream_id;
  this.next_stream_id += 2;
};

Connection.prototype._read = function read() {
};

Connection.prototype._write = function write(chunk, encoding, callback) {
};
