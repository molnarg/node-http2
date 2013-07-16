var Serializer   = require('./framer').Serializer;
var Deserializer = require('./framer').Deserializer;
var Compressor   = require('./compressor').Compressor;
var Decompressor = require('./compressor').Decompressor;
var Connection   = require('./connection').Connection;
var Duplex       = require('stream').Duplex;

exports.Peer   = Peer;
exports.Client = Client;
exports.Server = Server;

// Peer
// ----

function Peer(firstStreamId, settings, log) {
  Duplex.call(this);

  this._log = log || require('./utils').nolog;

  this._initializeDataFlow(firstStreamId, settings);
}
Peer.prototype = Object.create(Duplex.prototype, { constructor: { value: Peer } });

// Data flow
// ---------

// Internal structure of a HTTP/2 peer object:
//
//     +---------------------------------------------+
//     |                                             |
//     |   +-------------------------------------+   |
//     |   | +---------+ +---------+ +---------+ |   |
//     |   | | stream1 | | stream2 | |   ...   | |   |
//     |   | +---------+ +---------+ +---------+ |   |
//     |   |             connection              |   |
//     |   +-------------------------------------+   |
//     |             |                 ^             |
//     |        pipe |                 | pipe        |
//     |             v                 |             |
//     |   +------------------+------------------+   |
//     |   |    compressor    |   decompressor   |   |
//     |   +------------------+------------------+   |
//     |             |                 ^             |
//     |        pipe |                 | pipe        |
//     |             v                 |             |
//     |   +------------------+------------------+   |
//     |   |    serializer    |   deserializer   |   |
//     |   +------------------+------------------+   |
//     |             |                 ^             |
//     |             |                 |             |
//     |             v                 |             |
//     +---------------------------------------------+
//                   |                 ^
//            read() |                 | write()
//                   v                 |

Peer.prototype._initializeDataFlow = function _initializeDataFlow(firstStreamId, settings) {
  this._serializer   = new Serializer();
  this._deserializer = new Deserializer();
  this._compressor   = new Compressor();
  this._decompressor = new Decompressor();
  this._connection   = new Connection(firstStreamId, settings, this._log);

  this._connection.pipe(this._compressor).pipe(this._serializer);
  this._deserializer.pipe(this._decompressor).pipe(this._connection);
};

Peer.prototype._read = function _read(size) {
  var more_needed = true, chunk;
  while (more_needed && (chunk = this._serializer.read(size))) {
    more_needed = this.push(chunk);
  }

  if (more_needed) {
    this._serializer.once('readable', this._read.bind(this));
  }
};

Peer.prototype._write = function _write(chunk, encoding, done) {
  this._deserializer.write(chunk, encoding, done);
};

// Client
// ------

var CLIENT_HEADER = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Client is a Peer subclass.
function Client(log) {
  Peer.call(this, 1, log, {});

  this._writeClientHeader();
}
Client.prototype = Object.create(Peer.prototype, { constructor: { value: Client } });

// Writing the client header is simple and synchronous.
Server.prototype._writeClientHeader = function _writeClientHeader() {
  this.push(CLIENT_HEADER);
};

// Server
// ------

// Server is a Peer subclass.
function Server(log) {
  Peer.call(this, log);

  this._readClientHeader();
}
Server.prototype = Object.create(Peer.prototype, { constructor: { value: Server } });

// The asynchronous process of reading the client header:
Server.prototype._readClientHeader = function _readClientHeader() {
  // * progress in the header is tracker using a `cursor`
  var cursor = 0;

  // * `_write` is temporarily replaced by the comparator function
  this._write = function _temporalWrite(chunk, encoding, done) {
    // * which compares the stored header with the current `chunk` byte by byte and emits the
    //   'error' event if there's a byte that doesn't match
    var offset = cursor;
    while(cursor < CLIENT_HEADER.length && (cursor - offset) < chunk.length) {
      if (CLIENT_HEADER[cursor] !== chunk[cursor - offset]) {
        return this.emit('error', 'Handshake error');
      }
      cursor += 1;
    }

    // * if the whole header is over, and there were no error then restore the original `_write`
    //   and call it with the remaining part of the current chunk
    if (cursor === CLIENT_HEADER.length) {
      delete this._write;
      chunk = chunk.slice(cursor - offset);
      this._write(chunk, encoding, done);
    }
  };
};
