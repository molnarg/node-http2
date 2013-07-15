var Duplex = require('stream').Duplex;

var Serializer = require('./framer').Serializer;
var Deserializer = require('./framer').Deserializer;
var Compressor = require('./compressor').Compressor;

exports.Connection = Connection;

// Structure of a connection instance:
//
//      |    ^             |    ^
//      v    |             v    |
// +--------------+   +--------------+
// |   stream1    |   |   stream2    |
// | +----------+ |   | +----------+ |   ...
// | | stream1. | |   | | stream2. | |
// +-| upstream |-+   +-| upstream |-+
//   +----------+       +----------+
//      |    ^             |    ^
// read |    | write       |    |
//      v    |             v    |
// +-----------------------------+
// |         connection          |
// +-----------------------------+
//         |             ^
//    pipe |             | pipe
//         v             |
// +--------------+--------------+
// |  compressor  | decompressor |
// +--------------+--------------+
//         |             ^
//    pipe |             | pipe
//         v             |
// +--------------+--------------+
// |  serializer  | deserializer |
// +--------------+--------------+
//         |             ^
//    pipe |             | pipe
//         v             |
// +-----------------------------+
// |           socket            |
// +-----------------------------+

function Connection(role, socket, settings, initialRequest, initialResponse) {
  Duplex.call(this, { objectMode: true });

  this.socket = socket;
  this.role = role; // 'client' or 'server'
  this.next_stream_id = (this.role === 'CLIENT') ? 1 : 2;
  this.serializer = new Serializer();
  this.deserializer = new Deserializer();
  this.compressor = new Compressor();

  this.pipe(this.compressor).pipe(this.serializer).pipe(this.socket);
  this.socket.pipe(this.deserializer).pipe(this.decompressor).pipe(this);
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
