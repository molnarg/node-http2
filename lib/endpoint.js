var logging      = require('./logging');
var Serializer   = require('./framer').Serializer;
var Deserializer = require('./framer').Deserializer;
var Compressor   = require('./compressor').Compressor;
var Decompressor = require('./compressor').Decompressor;
var Connection   = require('./connection').Connection;
var Duplex       = require('stream').Duplex;

exports.Endpoint = Endpoint;

// Endpoint
// ========

function Endpoint(role, settings, log) {
  Duplex.call(this);

  this._log = (log || logging.root).child({ component: 'endpoint' });

  // * The handshake process is split into two parts:
  //
  // ** The asymmetric part: sending and receiving the client header prelude.
  //    This is done by the `_writePrelude` and `_readPrelude` methods.
  // ** The symmetric part: sending the first SETTINGS frame.
  //    This is done by the connection class right after initialization (`_initializeDataFlow`).

  var firstStreamId;
  switch(role) {
    case 'CLIENT':
      this._writePrelude();
      firstStreamId = 1;
      break;
    case 'SERVER':
      this._readPrelude();
      firstStreamId = 2;
      break;
    default:
      throw new Error('Invalid role: ' + role);
  }

  this._initializeDataFlow(firstStreamId, settings);

  this._initializeErrorHandling();
}
Endpoint.prototype = Object.create(Duplex.prototype, { constructor: { value: Endpoint } });

// Handshake
// ---------

var CLIENT_HEADER = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Writing the client header is simple and synchronous.
Endpoint.prototype._writePrelude = function _writePrelude() {
  this._log.info('Sending the client connection header prelude.');
  this.push(CLIENT_HEADER);
};

// The asynchronous process of reading the client header:
Endpoint.prototype._readPrelude = function _readPrelude() {
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

// Data flow
// ---------

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
  this._serializer   = new Serializer(this._log);
  this._deserializer = new Deserializer(this._log);
  this._compressor   = new Compressor(this._log);
  this._decompressor = new Decompressor(this._log);
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
