// [node-http2](https://github.com/molnarg/node-http2) consists of the following components:

// * [http.js](http.html): public node-http2 API
var http2        = require('./http');
module.exports = http2;

// * [utils.js](utils.html): common utility functions, like concatenating buffers
http2.utils      = require('./utils');

// * [logging.js](logging.html): a default logger object and a registry of log formatter functions
http2.logging    = require('./logging');

// * [framer.js](framer.html): the lowest layer in the stack that transforms between the binary and
//   the JavaScript object representation of HTTP/2 frames
http2.framer     = require('./framer');

// * [compressor.js](compressor.html): compression and decompression of HEADER frames
http2.compressor = require('./compressor');

// * [stream.js](stream.html): implementation of the HTTP/2 stream concept
http2.stream     = require('./stream');

// * [connection.js](connection.html): multiplexes streams, manages the identifiers of them and
//   repsonsible for connection level flow control
http2.connection = require('./connection');

// * [endpoint.js](endpoint.html): manages other components (framer, compressor, connection,
//   streams) and part of the handshake process
http2.endpoint   = require('./endpoint');
