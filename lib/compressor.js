exports.Compressor = Compressor

var EventEmitter = require('events').EventEmitter

function Compressor() {

}
Compressor.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Compressor } })

Compressor.prototype.compress = function compress(headers) {

}

Compressor.prototype.decompress = function decompress(buffer) {

}
