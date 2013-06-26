exports.Compressor = Compressor
exports.Decompressor = Decompressor

function Compressor() {

}

Compressor.prototype.compress = function compress(headers) {

}

function Decompressor() {

}
Decompressor.prototype.decompress = function decompress(buffer) {

}

// Low-level representations
// -------------------------

// The algorithm to represent an **integer** I is as follows:
//
// 1. If I < 2^N - 1, encode I on N bits
// 2. Else, encode 2^N - 1 on N bits and do the following steps:
//    1. Set I to (I - (2^N - 1)) and Q to 1
//    2. While Q > 0
//       1. Compute Q and R, quotient and remainder of I divided by 2^7
//       2. If Q is strictly greater than 0, write one 1 bit; otherwise, write one 0 bit
//       3. Encode R on the next 7 bits
//       4. I = Q

Compressor.integer = function writeInteger(I, N) {
  var limit = Math.pow(2,N) - 1
  if (I < limit) return [new Buffer([I])]

  var bytes = []
  if (N !== 0) {
    bytes.push(limit)
  }
  I -= limit

  var Q = 1, R
  while (Q > 0) {
    Q = Math.floor(I / 128)
    R = I % 128

    if (Q > 0) R += 128
    bytes.push(R)

    I = Q
  }

  return [new Buffer(bytes)]
}

// The inverse algorithm:
//
// 1. Set I to the number coded on the lower N bits of the first byte
// 2. If I is smaller than 2^N - 1 then return I
// 2. Else the number is encoded on more than one byte, so do the following steps:
//    1. Set M to 0
//    2. While returning with I
//       1. Let B be the next byte (the first byte if N is 0)
//       2. Read out the lower 7 bits of B and multiply it with 2^M
//       3. Increase I with this number
//       4. Increase M by 7
//       5. Return I if the most significant bit of B is 0

Decompressor.integer = function readInteger(buffer, N) {
  var I, limit = Math.pow(2,N) - 1

  I = buffer[buffer.cursor] & limit
  if (N !== 0) {
    buffer.cursor += 1
  }

  if (I === limit) {
    var M = 0
    do {
      I += (buffer[buffer.cursor] & 127) << M
      M += 7
      buffer.cursor += 1
    } while (buffer[buffer.cursor - 1] & 128)
  }

  return I
}

// Literal **strings** can represent header names or header values.  They are encoded in two parts:
//
// 1. The string length, defined as the number of bytes needed to store its UTF-8 representation,
//    is represented as an integer with a zero bits prefix.  If the string length is strictly less
//    than 128, it is represented as one byte.
// 2. The string value represented as a list of UTF-8 characters.

Compressor.string = function writeString(str) {
  var encoded_string = new Buffer(str, 'utf8')
    , encoded_length = Compressor.integer(encoded_string.length, 0)
  return encoded_length.concat(encoded_string)
}

Decompressor.string = function readString(buffer) {
  var length = Decompressor.integer(buffer, 0)
    , str = buffer.toString('utf8', buffer.cursor, buffer.cursor + length)
  buffer.cursor += length
  return str
}
