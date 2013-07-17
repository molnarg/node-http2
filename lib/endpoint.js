var logging      = require('./logging');
var Serializer   = require('./framer').Serializer;
var Deserializer = require('./framer').Deserializer;
var Compressor   = require('./compressor').Compressor;
var Decompressor = require('./compressor').Decompressor;
var Connection   = require('./connection').Connection;
var Duplex       = require('stream').Duplex;

exports.Endpoint = Endpoint;
exports.Client   = Client;
exports.Server   = Server;

// Endpoint
// ========

function Endpoint(firstStreamId, settings, log) {
  Duplex.call(this);

  this._log = log || logging.root;

  this._initializeDataFlow(firstStreamId, settings);

  this._initializeErrorHandling();
}
Endpoint.prototype = Object.create(Duplex.prototype, { constructor: { value: Endpoint } });

// Data flow
// ---------

// Internal structure of an HTTP/2 endpoint:
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
//     |     _read() |                 | _write()    |
//     |             v                 |             |
//     |      +------------+     +-----------+       |
//     |      |output queue|     |input queue|       |
//     +------+------------+-----+-----------+-------+
//                   |                 ^
//            read() |                 | write()
//                   v                 |

Endpoint.prototype._initializeDataFlow = function _initializeDataFlow(firstStreamId, settings) {
  this._serializer   = new Serializer();
  this._deserializer = new Deserializer();
  this._compressor   = new Compressor();
  this._decompressor = new Decompressor();
  this._connection   = new Connection(firstStreamId, settings, this._log);

  this._connection.pipe(this._compressor).pipe(this._serializer);
  this._deserializer.pipe(this._decompressor).pipe(this._connection);
};

Endpoint.prototype._read = function _read(size) {
  var more_needed = true, chunk;
  while (more_needed && (chunk = this._serializer.read(size))) {
    more_needed = this.push(chunk);
  }

  if (more_needed) {
    this._serializer.once('readable', this._read.bind(this));
  }
};

Endpoint.prototype._write = function _write(chunk, encoding, done) {
  this._deserializer.write(chunk, encoding, done);
};

// Error handling
// --------------

Endpoint.prototype._initializeErrorHandling = function _initializeErrorHandling() {
  this._serializer.on('error', this._error.bind(this, 'serializer'));
  this._deserializer.on('error', this._error.bind(this, 'deserializer'));
  this._compressor.on('error', this._error.bind(this, 'compressor'));
  this._decompressor.on('error', this._error.bind(this, 'decompressor'));
  this._connection.on('error', this._error.bind(this, 'connection'));
};

Endpoint.prototype._error = function _error(component, message) {
  this._log.fatal({ component: component, message: message }, 'Fatal error, closing connection');
  this.push(null);
  this.emit('error', component, message);
};

// Client
// ======

var CLIENT_HEADER = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Client is a Endpoint subclass.
function Client(log) {
  Endpoint.call(this, 1, {}, log);

  this._writeClientHeader();
}
Client.prototype = Object.create(Endpoint.prototype, { constructor: { value: Client } });

// Writing the client header is simple and synchronous.
Client.prototype._writeClientHeader = function _writeClientHeader() {
  this._log.info('Sending the client connection header prelude.');
  this.push(CLIENT_HEADER);
};

// Server
// ======

// Server is a Endpoint subclass.
function Server(log) {
  Endpoint.call(this, 2, {}, log);

  this._readClientHeader();
}
Server.prototype = Object.create(Endpoint.prototype, { constructor: { value: Server } });

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
        this._log.fatal({ cursor: cursor, offset: offset, chunk: chunk },
                        'Client connection header prelude does not match.');
        return this._error('handshake', 'Client connection header prelude does not match.');
      }
      cursor += 1;
    }

    // * if the whole header is over, and there were no error then restore the original `_write`
    //   and call it with the remaining part of the current chunk
    if (cursor === CLIENT_HEADER.length) {
      this._log.info('Successfully received the client connection header prelude.');
      delete this._write;
      chunk = chunk.slice(cursor - offset);
      this._write(chunk, encoding, done);
    }
  };
};
