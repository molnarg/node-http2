var framer     = require('./framer');
var compressor = require('./compressor');
var connection = require('./connection');

exports.Peer   = Peer;
exports.Client = Client;
exports.Server = Server;

// Peer
// ----

function Peer(socket, log) {
  this._socket = socket;
  this._log = log || require('./utils').nolog;
}

// Internal structure of a HTTP/2 peer object:
//
//     +-------------------------------------+
//     | +---------+ +---------+ +---------+ |
//     | | stream1 | | stream2 | |   ...   | |
//     | +---------+ +---------+ +---------+ |
//     |             connection              |
//     +-------------------------------------+
//               |                 ^
//          pipe |                 | pipe
//               v                 |
//     +------------------+------------------+
//     |    compressor    |   decompressor   |
//     +------------------+------------------+
//               |                 ^
//          pipe |                 | pipe
//               v                 |
//     +------------------+------------------+
//     |    serializer    |   deserializer   |
//     +------------------+------------------+
//               |                 ^
//          pipe |                 | pipe
//               v                 |
//     +-------------------------------------+
//     |               socket                |
//     +-------------------------------------+

Peer.prototype._initializeDataFlow = function _initializeDataFlow(firstStreamId, settings) {
  this._serializer   = new framer.Serializer();
  this._deserializer = new framer.Deserializer();
  this._compressor   = new compressor.Compressor();
  this._decompressor = new compressor.Decompressor();
  this._connection   = new connection.Connection(firstStreamId, settings, this._log);

  this._connection.pipe(this._compressor).pipe(this._serializer).pipe(this._socket);
  this._socket.pipe(this._deserializer).pipe(this._decompressor).pipe(this._connection);
};

var CLIENT_HEADER = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

// Client
// ------

// Client is a Peer subclass.
//
// The constructor pushes out the client specific header and then initializes the components that
// make up a HTTP/2 client.
function Client(socket, log) {
  Peer.call(this, socket, log);

  this._writeClientHeader();
  this._initializeDataFlow(1, {});
}
Client.prototype = Object.create(Peer.prototype, { constructor: { value: Client } });

// Writing the client header is simple and synchronous.
Server.prototype._writeClientHeader = function _writeClientHeader() {
  this._socket.write(CLIENT_HEADER);
};

// Server
// ------

// Server is a Peer subclass.
//
// The constructor reads in the client specific header and then initializes the components that
// make up a HTTP/2 server.
function Server(socket, log) {
  Peer.call(this, socket, log);

  this._readClientHeader(this._initializeDataFlow.bind(this, 1, {}));
}
Server.prototype = Object.create(Peer.prototype, { constructor: { value: Server } });

// The asynchronous process of reading the client header:
Server.prototype._readClientHeader = function _readClientHeader(done) {
  var buffer = this._socket.read(CLIENT_HEADER.length);

  // * If there's not enough data in the socket currently, then come back when there is.
  if (buffer === null) {
    this._socket.once('readable', this._readClientHeader.bind(this, done));
    return;
  }

  // * If we pulled out too much data, push back the remaining bytes.
  if (buffer.length > CLIENT_HEADER.length) {
    this._socket.unshift(buffer.slice(CLIENT_HEADER.length));
    buffer = buffer.slice(0, CLIENT_HEADER.length);
  }

  // * Check if the client sent the connection header first.
  if (buffer.toString() === CLIENT_HEADER) {
    done();
  }

  // * Clients and servers MUST terminate the TCP connection if either peer does not begin with a
  //   valid connection header.
  else {
    this._socket.end();
  }
};
