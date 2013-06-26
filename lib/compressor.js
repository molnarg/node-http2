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

  var bytes = [limit]
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
// 1. If the lower N bits of the first byte is not all-one, then return the number coded
//    on the lower N bits
// 2. Else the number is encoded on more than one byte, so do the following steps:
//    1. Set I to 2^N - 1 and M to 0
//    2. While returning with I
//       1. Let B be the next byte
//       2. Read out the lower 7 bits of B and multiply it with 2^M
//       3. Increase I with this number
//       4. Increase M by 7
//       5. Return I if the most significant bit of B is 0

Decompressor.integer = function readInteger(buffer, N) {
  var I, limit = Math.pow(2,N) - 1

  if ((buffer[buffer.cursor] & limit) < limit) {
    I = buffer[buffer.cursor]

  } else {
    I = limit
    var M = 0
    do {
      buffer.cursor += 1
      I += (buffer[buffer.cursor] & 127) << M
      M += 7
    } while (buffer[buffer.cursor] & 128)
  }

  buffer.cursor += 1
  return I
}
