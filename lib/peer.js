var framer     = require('./framer');
var compressor = require('./compressor');
var connection = require('./connection');

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

function Peer(socket) {
  this.socket = socket;
  
  this.serializer   = new framer.Serializer();
  this.deserializer = new framer.Deserializer();
  this.compressor   = new compressor.Compressor();
  this.decompressor = new compressor.Decompressor();
  this.connection   = new connection.Connection();

  this.connection.pipe(this.compressor).pipe(this.serializer).pipe(this.socket);
  this.socket.pipe(this.deserializer).pipe(this.decompressor).pipe(this.connection);
}
