exports.Compressor = Compressor;
exports.Decompressor = Decompressor;
exports.CompressionContext = CompressionContext;

function Compressor(request) {
  var initial_table = request ? CompressionContext.initialRequestTable : CompressionContext.initialResponseTable
  this._context = new CompressionContext(initial_table)
}

Compressor.prototype.compress = function compress(headers) {
  // { name: value, ... } -> [[name, value], ... ]
  var pairs = [];
  for (var name in headers) {
    var value = headers[name]
    if (value instanceof Array) {
      for (i = 0; i< value.length; i++) {
        pairs.push([name, value[i]]);
      }
    } else {
      pairs.push([name, value]);
    }
  }

  // Diff encoding
  var entries = this._context.encode(pairs);

  // Serialization
  var buffers = [];
  for (var i = 0; i < entries.length; i++) {
    buffers.push(Compressor.header(entries[i]));
  }

  return Array.prototype.concat.apply([], buffers);
};

function Decompressor() {
  var initial_table = request ? CompressionContext.initialRequestTable : CompressionContext.initialResponseTable
  this._context = new CompressionContext(initial_table)
}
Decompressor.prototype.decompress = function decompress(buffer) {
  // Deserialization
  var entries = [];
  buffer.cursor = 0;
  while (buffer.cursor < buffer.length) {
    entries.push(Decompressor.header(buffer));
  }

  // Diff decoding
  var pairs = this._context.decode(entries);

  // [[name, value], ... ] -> { name: value, ... }
  var headers = {}
  for (var i = 0; i < pairs.length; i++) {
    var name = pairs[i][0]
      , value = pairs[i][1];
    if (name in headers) {
      if (headers[name] instanceof Array) {
        headers[name].push(value);
      } else {
        headers[name] = [headers[name], value];
      }
    } else {
      headers[name] = value;
    }
  }

  return headers;
};

// [Header Encoding](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-3)
// =================

function CompressionContext(table, limit) {
  this._table = table ? table.slice() : [];
  this._limit = limit || 4096;
  this._reference = []
}

// To ensure a correct decoding of a set of headers, the following steps or equivalent ones MUST be
// executed by the decoder.
CompressionContext.prototype.decode = function(diff) {
  // First, upon starting the decoding of a new set of headers, the reference set of headers is
  // interpreted into the working set of headers: for each header in the reference set, an entry is
  // added to the working set.
  var table = this._table
    , working = this._reference.slice();

  // Then, the header representations are processed in their order of occurrence in the frame.
  for (var i = 0; i < diff.length; i++) {
    var entry = diff[i], pair;
    if (typeof entry.value === 'number') {
      // For an indexed representation, the decoder checks whether the index is present in the
      // working set. If true, the corresponding entry is removed from the working set.  If several
      // entries correspond to this encoded index, all these entries are removed from the working
      // set. If the index is not present in the working set, it is used to retrieve the
      // corresponding header from the header table, and a new entry is added to the working set
      // representing this header.
      pair = table[entry.value];
      var working_index = working.indexOf(pair);
      if (working_index !== -1) {
        do {
          working.splice(working_index, 1);
        } while ((working_index = working.indexOf(pair)) !== -1)
      } else {
        working.push(pair);
      }
    } else {
      // For a literal representation, a new entry is added to the working set representing this
      // header. If the literal representation specifies that the header is to be indexed, the
      // header is added accordingly to the header table.
      if (typeof entry.name === 'number') {
        pair = [table[entry.name][0], entry.value];
      } else {
        pair = [entry.name, entry.value];
      }
      working.push(pair);

      if (entry.indexing) {
        if ('substitution' in entry) {
          table.splice(entry.substitution, 1, pair);
        } else {
          table.push(pair);
        }
        this._enforceSizeBound();
      }
    }
  }

  // The new reference set of headers is computed by removing from the working set all the headers
  // that are not present in the header table.
  this._reference = working.filter(function(header) {
    return table.indexOf(header) !== -1;
  });

  // When all the header representations have been processed, the working set contains all the
  // headers of the set of headers.
  return working;
};

CompressionContext.prototype.encode = function(workingset) {
  var table = this._table
    , old_reference = this._reference
    , new_reference = []
    , diff = [];

  for (var i = 0; i < workingset.length; i++) {
    var pair = workingset[i], fullmatch, namematch;
    for (var j = 0; j < table.length; i++) {
      if (table[j][0] === pair[0]) {
        if (table[j][1] === pair[1]) {
          fullmatch = j;
          pair = table[fullmatch];
          break;
        } else {
          namematch = j;
        }
      }
    }

    if (fullmatch !== undefined && old_reference.indexOf(pair) === -1) {
      diff.push({
        name: fullmatch,
        value: fullmatch
      });
      new_reference.push(table[fullmatch]);

    } else if (fullmatch === undefined) {
      diff.push({
        name: namematch !== undefined ? namematch : pair[0],
        value: pair[1],
        indexing: true
      })
      new_reference.push(pair);
      table.push(pair);
      this._enforceSizeBound();
    }
  }

  for (var k = 0; k < old_reference.length; k++) {
    var reference_pair = old_reference[k];
    if (!(reference_pair in new_reference)) {
      var unneeded_index = table.indexOf(reference_pair);
      if (unneeded_index !== -1) {
        diff.push({
          name: unneeded_index,
          value: unneeded_index
        })
      }
    }
  }

  this._reference = new_reference
}

// The header table size can be bounded so as to limit the memory requirements.
// The _cut() method drops the entrys that are over the memory limit (`this._limit`)
CompressionContext.prototype._enforceSizeBound = function() {
  // The header table size is defined as the sum of the size of each entry of the table.  The size
  // of an entry is the sum of the length in bytes of its name, of value's length in bytes and of
  // 32 bytes (for accounting for the entry structure overhead).
  var table = this._table;
  var size = 0;
  for (var i = 0; i < table.length; i++) {
    if (table[i].size === undefined) {
      table[i].size = new Buffer(table[i][0] + table[i][1], 'utf8').length + 32;
    }
    size += table[i].size;
  }
  while (size > this._limit) {
    var dropped = table.shift();
    size -= dropped.size;
  }
};

// [Detailed Format](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-4)
// =================

// Integer representation
// ----------------------
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

Compressor.string = function writeString(stringbuffer) {
  var encoded_length = Compressor.integer(stringbuffer.length, 0);
  return encoded_length.concat(stringbuffer);
};

Decompressor.string = function readString(buffer) {
  var length = Decompressor.integer(buffer, 0)
    , stringbuffer = buffer.slice(buffer.cursor, buffer.cursor + length);
  buffer.cursor += length;
  return stringbuffer;
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

// [Initial header names](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#appendix-A)
// ======================

CompressionContext.initialRequestTable  = [
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':host'],
  [':path', '/'],
  [':method', 'get']
];

CompressionContext.initialResponseTable = [
  [':status', '200'],
  ['age'],
  ['cache-control'],
  ['content-length'],
  ['content-type']
];
