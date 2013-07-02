exports.Compressor = Compressor;
exports.Decompressor = Decompressor;
exports.CompressionContext = CompressionContext;

// [Header Encoding](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-3)
// =================

function CompressionContext(table, limit) {
  this._table = table ? table.slice() : [];
  this._limit = limit || 4096;
  this._working = [];
  this._reference = [];
}

CompressionContext.equal = function(pair1, pair2) {
  // Header names are always represented as lower-case strings.  An input header name matches the
  // header name of a (name, value) pair stored in the Header Table if they are equal using a
  // character-based, _case insensitive_ comparison.  An input header value matches the header value
  // of a (name, value) pair stored in the Header Table if they are equal using a character-based,
  // _case sensitive_ comparison. An input header (name, value) pair matches a pair in the Header
  // Table if both the name and value are matching as per above.
  return (pair1[0].toLowerCase() === pair2[0].toLowerCase()) && (pair1[1] === pair2[1]);
};

CompressionContext.prototype.getWorkingSet = function getWorkingSet() {
  return this._working.map(function(entry) {
    return entry.pair;
  });
};

CompressionContext.prototype.reinitialize = function reinitialize() {
  var self = this;

  // The new reference set of headers is computed by removing from the working set all the headers
  // that are not present in the header table.
  this._reference = this._working.filter(function(entry) {
    return self._table.indexOf(entry.pair) !== -1
  }).map(function(entry) {
    return entry.pair;
  });

  // The reference set of headers is interpreted into the working set of headers: for each header
  // in the reference set, an entry is added to the working set, containing the header name, its
  // value, and its current index in the header table.
  this._working = this._reference.map(function(pair) {
    var index = self._table.indexOf(pair);
    return { index: index, pair: pair };
  });
};

CompressionContext.prototype.execute = function execute(command) {
  var index, pair;

  // For an indexed representation, the decoder checks whether the index is present in the working
  // set. If true, the corresponding entry is removed from the working set. If several entries
  // correspond to this encoded index, all these entries are removed from the working set. If the
  // index is not present in the working set, it is used to retrieve the corresponding header from
  // the header table, and a new entry is added to the working set representing this header.
  if (typeof command.value === 'number') {
    index = command.value;
    var filtered = this._working.filter(function(entry) {
      return entry.index !== index;
    });
    if (filtered.length === this._working.length) {
      pair = this._table[index];
      this._working.push({ index: index, pair: pair });
    } else {
      this._working = filtered;
    }
  }

  // For a literal representation, a new entry is added to the working set representing this header.
  // If the literal representation specifies that the header is to be indexed, the header is added
  // accordingly to the header table, and its index is included in the entry in the working set.
  // Otherwise, the entry in the working set contains an undefined index.
  else {
    if (typeof command.name === 'number') {
      pair = [this._table[command.name][0], command.value];
    } else {
      pair = [command.name, command.value];
    }

    if (command.indexing) {
      if ('substitution' in command) {
        this._table.splice(command.substitution, 1, pair);
      } else {
        this._table.push(pair);
      }
      this._enforceSizeBound();           // TODO: The order of these two
      index = this._table.indexOf(pair);  // TODO: operation is not well defined!
    }

    this._working.push({ index: index, pair: pair });
  }
};

CompressionContext.prototype.generateAddCommand = function(pair) {
  return {
    name: pair[0],
    value: pair[1]
  }
};

CompressionContext.prototype.generateRemoveCommand = function(pair) {
  for (var i = 0; i < this._working.length; i++) {
    var entry = this._working[i];
    if (entry.pair === pair) {
      return {
        name: entry.index,
        value: entry.index
      };
    }
  }
  return undefined;
};

// The header table size can be bounded so as to limit the memory requirements.
// The _enforceSizeBound() method drops the entrys that are over the memory limit (`this._limit`)
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

// Compression process
// ===================

function Compressor(request) {
  var initial_table = request ? CompressionContext.initialRequestTable
                              : CompressionContext.initialResponseTable
  this._context = new CompressionContext(initial_table)
}

Compressor.prototype.compress = function compress(headers) {
  var i;

  // First, the usual node.js header set format (`{ name1: value1, name2: [value2, value3], ... }`)
  // has to be converted to `[name, value]` pairs.
  var pairs = [];
  for (var name in headers) {
    var value = headers[name];
    if (value instanceof Array) {
      for (i = 0; i< value.length; i++) {
        pairs.push([name, value[i]]);
      }
    } else {
      pairs.push([name, value]);
    }
  }

  // The next step is generating commands that make the working set equal to the generated pair set.
  // Before starting the process, the reference set and the working set has to be reinitialized.
  this._context.reinitialize()
  var working = this._context.getWorkingSet(), command, commands = []

  // The first commands remove the unneeded headers from the working set.
  for (i = 0; i < working.length; i++) {
    if (!pairs.some(CompressionContext.equal.bind(null, working[i]))) {
      command = this._context.generateRemoveCommand(working[i]);
      this._context.execute(command);
      commands.push(command);
    }
  }

  // Then the headers that are not present in the working set yet are added.
  for (i = 0; i < pairs.length; i++) {
    if (!working.some(CompressionContext.equal.bind(null, pairs[i]))) {
      command = this._context.generateAddCommand(pairs[i]);
      this._context.execute(command)
      commands.push(command)
    }
  }

  // The last step is the serialization of the generated commands.
  var buffers = [];
  for (i = 0; i < commands.length; i++) {
    buffers.push(Compressor.header(commands[i]));
  }

  return Array.prototype.concat.apply([], buffers);
};

// Decompression process
// =====================

function Decompressor(request) {
  var initial_table = request ? CompressionContext.initialRequestTable
                              : CompressionContext.initialResponseTable
  this._context = new CompressionContext(initial_table)
}
// To ensure a correct decoding of a set of headers, the following steps or equivalent ones MUST
// be executed by the decoder.
Decompressor.prototype.decompress = function decompress(buffer) {
  // First, upon starting the decoding of a new set of headers, the reference set of headers is
  // interpreted into the working set of headers
  this._context.reinitialize()

  // Then, the header representations are processed in their order of occurrence in the frame.
  buffer.cursor = 0;
  while (buffer.cursor < buffer.length) {
    this._context.execute(Decompressor.header(buffer));
  }

  // When all the header representations have been processed, the working set contains all the
  // headers of the set of headers.
  var pairs = this._context.getWorkingSet()

  // The working set entries are `[name, value]` pairs. These must be converted to the usual header
  // set format used in node.js: `{ name1: value1, name2: [value2, value3], ... }`
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
  [ ':scheme'                     , 'http'  ],
  [ ':scheme'                     , 'https' ],
  [ ':host'                       , ''      ],
  [ ':path'                       , '/'     ],
  [ ':method'                     , 'get'   ],
  [ 'accept'                      , ''      ],
  [ 'accept-charset'              , ''      ],
  [ 'accept-encoding'             , ''      ],
  [ 'accept-language'             , ''      ],
  [ 'cookie'                      , ''      ],
  [ 'if-modified-since'           , ''      ],
  [ 'keep-alive'                  , ''      ],
  [ 'user-agent'                  , ''      ],
  [ 'proxy-connection'            , ''      ],
  [ 'referer'                     , ''      ],
  [ 'accept-datetime'             , ''      ],
  [ 'authorization'               , ''      ],
  [ 'allow'                       , ''      ],
  [ 'cache-control'               , ''      ],
  [ 'connection'                  , ''      ],
  [ 'content-length'              , ''      ],
  [ 'content-md5'                 , ''      ],
  [ 'content-type'                , ''      ],
  [ 'date'                        , ''      ],
  [ 'expect'                      , ''      ],
  [ 'from'                        , ''      ],
  [ 'if-match'                    , ''      ],
  [ 'if-none-match'               , ''      ],
  [ 'if-range'                    , ''      ],
  [ 'if-unmodified-since'         , ''      ],
  [ 'max-forwards'                , ''      ],
  [ 'pragma'                      , ''      ],
  [ 'proxy-authorization'         , ''      ],
  [ 'range'                       , ''      ],
  [ 'te'                          , ''      ],
  [ 'upgrade'                     , ''      ],
  [ 'via'                         , ''      ],
  [ 'warning'                     , ''      ]
];

CompressionContext.initialResponseTable = [
  [ ':status'                     , '200'   ],
  [ 'age'                         , ''      ],
  [ 'cache-control'               , ''      ],
  [ 'content-length'              , ''      ],
  [ 'content-type'                , ''      ],
  [ 'date'                        , ''      ],
  [ 'etag'                        , ''      ],
  [ 'expires'                     , ''      ],
  [ 'last-modified'               , ''      ],
  [ 'server'                      , ''      ],
  [ 'set-cookie'                  , ''      ],
  [ 'vary'                        , ''      ],
  [ 'via'                         , ''      ],
  [ 'access-control-allow-origin' , ''      ],
  [ 'accept-ranges'               , ''      ],
  [ 'allow'                       , ''      ],
  [ 'connection'                  , ''      ],
  [ 'content-disposition'         , ''      ],
  [ 'content-encoding'            , ''      ],
  [ 'content-language'            , ''      ],
  [ 'content-location'            , ''      ],
  [ 'content-md5'                 , ''      ],
  [ 'content-range'               , ''      ],
  [ 'link'                        , ''      ],
  [ 'location'                    , ''      ],
  [ 'p3p'                         , ''      ],
  [ 'pragma'                      , ''      ],
  [ 'proxy-authenticate'          , ''      ],
  [ 'refresh'                     , ''      ],
  [ 'retry-after'                 , ''      ],
  [ 'strict-transport-security'   , ''      ],
  [ 'trailer'                     , ''      ],
  [ 'transfer-encoding'           , ''      ],
  [ 'warning'                     , ''      ],
  [ 'www-authenticate'            , ''      ]
];
