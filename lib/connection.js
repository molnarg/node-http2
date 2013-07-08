var Duplex = require('stream').Duplex;

var Serializer = require('./framer').Serializer;
var Deserializer = require('./framer').Deserializer;
var Compressor = require('./compressor').Compressor;

exports.Connection = Connection;

function Connection(socket, role) {
  Duplex.call(this, { objectMode: true });

  this.socket = socket;
  this.role = role; // 'client' or 'server'
  this.next_stream_id = (this.role === 'client') ? 1 : 2;
  this.serializer = new Serializer();
  this.deserializer = new Deserializer();
  this.compressor = new Compressor();

  this.serializer.pipe(this.socket).pipe(this.deserializer);
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
