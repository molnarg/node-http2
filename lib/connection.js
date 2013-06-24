exports.Connection = Connection

var Serializer = require('./framer').Serializer
  , Deserializer = require('./framer').Deserializer
  , Compressor = require('./compressor').Compressor
  , EventEmitter = require('events').EventEmitter

function Connection(socket, role) {
  this.socket = socket
  this.role = role // 'client' or 'server'
  this.next_stream_id = (this.role === 'client') ? 1 : 2
  this.serializer = new Serializer()
  this.deserializer = new Deserializer()
  this.compressor = new Compressor()

  this.serializer.pipe(this.socket).pipe(this.deserializer)
}
Connection.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Connection } })

Connection.prototype.createStream = function createStream() {
  var id = this.next_stream_id
  this.next_stream_id += 2
}
