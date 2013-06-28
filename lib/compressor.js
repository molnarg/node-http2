exports.Compressor = Compressor;
exports.Decompressor = Decompressor;

function Compressor() {

}

Compressor.prototype.compress = function compress(headers) {

};

function Decompressor() {

}
Decompressor.prototype.decompress = function decompress(buffer) {

};

// Integer representation
// -------------------------
//
// The algorithm to represent an integer I is as follows:
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
  var limit = Math.pow(2,N) - 1;
  if (I < limit) {
    return [new Buffer([I])];
  }

  var bytes = [];
  if (N !== 0) {
    bytes.push(limit);
  }
  I -= limit;

  var Q = 1, R;
  while (Q > 0) {
    Q = Math.floor(I / 128);
    R = I % 128;

    if (Q > 0) {
      R += 128;
    }
    bytes.push(R);

    I = Q;
  }

  return [new Buffer(bytes)];
};

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

  I = buffer[buffer.cursor] & limit;
  if (N !== 0) {
    buffer.cursor += 1;
  }

  if (I === limit) {
    var M = 0;
    do {
      I += (buffer[buffer.cursor] & 127) << M;
      M += 7;
      buffer.cursor += 1;
    } while (buffer[buffer.cursor - 1] & 128)
  }

  return I;
};

// String literal representation
// -----------------------------
//
// Literal **strings** can represent header names or header values.  They are encoded in two parts:
//
// 1. The string length, defined as the number of bytes needed to store its UTF-8 representation,
//    is represented as an integer with a zero bits prefix.  If the string length is strictly less
//    than 128, it is represented as one byte.
// 2. The string value represented as a list of UTF-8 characters.

Compressor.string = function writeString(str) {
  var encoded_string = new Buffer(str, 'utf8')
    , encoded_length = Compressor.integer(encoded_string.length, 0);
  return encoded_length.concat(encoded_string);
};

Decompressor.string = function readString(buffer) {
  var length = Decompressor.integer(buffer, 0)
    , str = buffer.toString('utf8', buffer.cursor, buffer.cursor + length);
  buffer.cursor += length;
  return str;
}

// Header represenations
// ---------------------

// The **JavaScript object representation** of a header record:
//
//     {
//       name: String || Number,   // literal or index
//       value: String || Number,  // literal or index
//       indexing: Boolean,        // with or without indexing
//       substitution: Number      // substitution index
//     }
//
// Not all possible header objects are valid. Constraints:
//
// * if `value` is an index, `name` should be the same index and indexed representation is used
// * if `substitution` is used, indexing should be set to true

// **All binary header representations** start with a prefix signaling the representation type and
// an index represented using prefix coded integers:
//
//       0   1   2   3   4   5   6   7
//     +---+---+---+---+---+---+---+---+
//     | 1 |        Index (7+)         |  Indexed Representation
//     +---+---------------------------+
//
//     +---+---+---+---+---+---+---+---+
//     | 0 | 1 | 1 |    Index (5+)     |  Literal w/o Indexing
//     +---+---+---+-------------------+
//
//     +---+---+---+---+---+---+---+---+
//     | 0 | 1 | 0 |    Index (5+)     |  Literal w/ Incremental Indexing
//     +---+---+---+-------------------+
//
//     +---+---+---+---+---+---+---+---+
//     | 0 | 0 |      Index (6+)       |  Literal w/ Substitution Indexing
//     +---+---+-----------------------+
//
// The **Indexed Representation** consists of the 1-bit prefix and the Index that is represented as
// a 7-bit prefix coded integer and nothing else.
//
// After the first bits, **all literal representations** specify the header name, either as a
// pointer to the Header Table (Index) or a string literal. When the string literal representation
// is used, the Index is set to 0 and the string literal starts at the second byte.
//
// When using **Substitution Indexing**, a new index comes next represented as a 0-bit prefix
// integer, specifying the record in the Header Table that needs to be replaced.
//
// For **all literal representations**, the specification of the header value comes next. It is
// always represented as a string.

Compressor.header = function writeString(header) {
  var buffers = [];

  if (typeof header.value === 'number') {
    buffers.push(Compressor.integer(header.value, 7));
    buffers[0][0][0] |= 128;

  } else {
    var substitution = ('substitution' in header);
    var prefix = substitution ? 6 : 5;
    if (typeof header.name === 'number') {
      buffers.push(Compressor.integer(header.name + 1, prefix));
    } else {
      buffers.push(Compressor.integer(0, prefix));
      buffers.push(Compressor.string(header.name));
    }

    if (!substitution) {
      buffers[0][0][0] |= 64;
      if (!header.indexing) {
        buffers[0][0][0] |= 32;
      }
    }

    if (substitution) {
      buffers.push(Compressor.integer(header.substitution, 0));
    }

    buffers.push(Compressor.string(header.value));
  }

  return Array.prototype.concat.apply([], buffers); // array of arrays of buffers -> array of buffers
}

Decompressor.header = function readString(buffer) {
  var header = {};

  if (buffer[0] & 128) {
    var index = Decompressor.integer(buffer, 7);
    header.indexing = false;
    header.name = index;
    header.value = index;

  } else {
    var prefix, substitution;
    if (buffer[0] & 64) {
      header.indexing = !(buffer[0] & 32);
      prefix = 5;
    } else {
      header.indexing = true;
      substitution = true;
      prefix = 6;
    }

    header.name = Decompressor.integer(buffer, prefix) - 1;
    if (header.name === -1) {
      header.name = Decompressor.string(buffer);
    }

    if (substitution) {
      header.substitution = Decompressor.integer(buffer, 0);
    }

    header.value = Decompressor.string(buffer);
  }

  return header;
};
