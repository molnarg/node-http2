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

// Counter for globally unique endpoint ID generation
var nextId = 0;

// The process of initialization:
function Endpoint(role, settings, log) {
  Duplex.call(this);

  // * Initializing logging infrastructure
  this.id = nextId++;
  this._log = (log || logging.root).child({ component: 'endpoint', e: this.id });

  // * First part of the handshake process: sending and receiving the client connection header
  //   prelude.
  if (role === 'CLIENT') {
    this._writePrelude();
  } else if (role === 'SERVER') {
    this._readPrelude();
  } else {
    throw new Error('Invalid role: ' + role);
  }

  // * Initialization of componenet. This includes the second part of the handshake process:
  //   sending the first SETTINGS frame. This is done by the connection class right after
  //   initialization.
  this._initializeDataFlow(role, settings);

  // * Initialization of management code.
  this._initializeManagement();

  // * Initializing error handling.
  this._initializeErrorHandling();
}
Endpoint.prototype = Object.create(Duplex.prototype, { constructor: { value: Endpoint } });

// Handshake
// ---------

var CLIENT_PRELUDE = new Buffer('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Writing the client header is simple and synchronous.
Endpoint.prototype._writePrelude = function _writePrelude() {
  this._log.info('Sending the client connection header prelude.');
  this.push(CLIENT_PRELUDE);
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
    while(cursor < CLIENT_PRELUDE.length && (cursor - offset) < chunk.length) {
      if (CLIENT_PRELUDE[cursor] !== chunk[cursor - offset]) {
        this._log.fatal({ cursor: cursor, offset: offset, chunk: chunk },
                        'Client connection header prelude does not match.');
        this._error('handshake', 'Client connection header prelude does not match.');
        return;
      }
      cursor += 1;
    }

    // * if the whole header is over, and there were no error then restore the original `_write`
    //   and call it with the remaining part of the current chunk
    if (cursor === CLIENT_PRELUDE.length) {
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

Endpoint.prototype._initializeDataFlow = function _initializeDataFlow(role, settings) {
  var firstStreamId, compressorRole, decompressorRole;
  if (role === 'CLIENT') {
    firstStreamId = 1;
    compressorRole = 'REQUEST';
    decompressorRole = 'RESPONSE';
  } else {
    firstStreamId = 2;
    compressorRole = 'RESPONSE';
    decompressorRole = 'REQUEST';
  }

  this._serializer   = new Serializer(this._log);
  this._deserializer = new Deserializer(this._log);
  this._compressor   = new Compressor(compressorRole, this._log);
  this._decompressor = new Decompressor(decompressorRole, this._log);
  this._connection   = new Connection(firstStreamId, settings, this._log);

  this._connection.pipe(this._compressor).pipe(this._serializer);
  this._deserializer.pipe(this._decompressor).pipe(this._connection);

  this._serializer.on('readable', this._read.bind(this));
};

Endpoint.prototype._read = function _read() {
  var moreNeeded = true, chunk;
  while (moreNeeded && (chunk = this._serializer.read())) {
    moreNeeded = this.push(chunk);
  }
};

Endpoint.prototype._write = function _write(chunk, encoding, done) {
  this._deserializer.write(chunk, encoding, done);
};

// Management
// --------------

Endpoint.prototype._initializeManagement = function _initializeManagement() {
  this._connection.on('stream', this.emit.bind(this, 'stream'));
};

Endpoint.prototype.createStream = function createStream() {
  return this._connection.createStream();
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

Endpoint.prototype._error = function _error(component, error) {
  this._log.fatal({ component: component, message: error }, 'Fatal error, closing connection');
  this.close(error);
};

Endpoint.prototype.close = function close(error) {
  this._connection.close(error);
};
