// HTTP/2 compression is implemented by two [Transform Stream][1] subclasses that operate in
// [object mode][2]: the Compressor and the Decompressor. These provide a layer between the
// [framer](framer.html) and the [connection handling component](connection.html) that
// generates/parses binary header data.
//
// Compression functionality is separated from the integration part. The latter is implemented in
// the last part of the file, while the larger part of the file is an implementation of the [HTTP/2
// Header Compression][3] spec. Both Compressor and Decompressor store their compression related
// state in CompressionContext objects. It is always accessed using methods that guarantee that
// it remains in a valid state.
//
// [1]: http://nodejs.org/api/stream.html#stream_class_stream_transform
// [2]: http://nodejs.org/api/stream.html#stream_new_stream_readable_options
// [3]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00

var Transform = require('stream').Transform;

exports.CompressionContext = CompressionContext;
exports.Decompressor = Decompressor;
exports.Compressor = Compressor;

// Compression Context
// ===================

// A `CompressionContext` consists of the following tables:
//
// * Header Table (`this._table`) that is limited in size (`this._limit`)
// * Reference Set (`this._reference`)
// * Working Set (`this._working`)
//
// Header Table and Reference Set entries are `[name, value]` pairs (where both are strings), while
// Working Set entries are objects with two properties: `index` (a number) and `pair` (a pair).
//
// There are only two methods that modifies the state of the tables: `reinitialize()` and
// `execute(command)`.
var DEFAULT_HEADER_TABLE_LIMIT = 4096;

function CompressionContext(table, limit) {
  this._table = table ? table.slice() : [];
  this._limit = limit || DEFAULT_HEADER_TABLE_LIMIT;
  this._reference = [];
  this._working = [];
}

// The `equal(pair1, pair2)` static method decides if two headers are considered equal. Name
// comparison is case insensitive while value comparison is case sensitive.
CompressionContext.equal = function(pair1, pair2) {
  return (pair1[0].toLowerCase() === pair2[0].toLowerCase()) && (pair1[1] === pair2[1]);
};

// `getWorkingSet()` returns the current working set as an array of `[name, value]` pairs.
CompressionContext.prototype.getWorkingSet = function getWorkingSet() {
  return this._working.map(function(entry) {
    return entry.pair;
  });
};

// `reinitialize()` must be called between parsing/generating header blocks.
CompressionContext.prototype.reinitialize = function reinitialize() {
  var self = this;

  // * It first executes the steps needed to *end the processing of the previous block*.
  // The new reference set of headers is computed by removing from the working set all the headers
  // that are not present in the header table.
  this._reference = this._working.filter(function(entry) {
    return self._table.indexOf(entry.pair) !== -1;
  }).map(function(entry) {
    return entry.pair;
  });

  // * Then *prepares the processing of the next block*.
  // The reference set of headers is interpreted into the working set of headers: for each header
  // in the reference set, an entry is added to the working set, containing the header name, its
  // value, and its current index in the header table.
  this._working = this._reference.map(function(pair) {
    var index = self._table.indexOf(pair);
    return { index: index, pair: pair };
  });
};

// `execute(command)` executes the given command ([header representation][1]): updates the Header
// Table and the Working Set.
// [1]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-3.3

// The *JavaScript object representation* of a command:
//
//     {
//       name: String || Integer,  // string literal or index
//       value: String || Integer, // string literal or index
//       index: Integer            // -1       : no indexing
//                                 // 0 - ...  : substitution indexing
//                                 // Infinity : incremental indexing
//     }
//
// Examples:
//
//     Indexed:
//     { name: 2  , value: 2  , index: -1       }
//     Literal:
//     { name: 2  , value: 'X', index: -1       } // without indexing
//     { name: 2  , value: 'Y', index: Infinity } // incremental indexing
//     { name: 'A', value: 'Z', index: 123      } // substitution indexing

CompressionContext.prototype.execute = function execute(command) {
  var index, pair;

  // * For an indexed representation, it checks whether the index is present in the working set.
  // If true, the corresponding entry is removed from the working set. If several entries correspond
  // to this encoded index, all these entries are removed from the working set. If the index is not
  // present in the working set, it is used to retrieve the corresponding header from the Header
  // Table, and a new entry is added to the working set representing this header.
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

  // * For a literal representation, a new entry is added to the working set representing this
  // header. If the literal representation specifies that the header is to be indexed, the header is
  // added accordingly to the header table, and its index is included in the entry in the working
  // set. Otherwise, the entry in the working set contains an undefined index.
  else {
    if (typeof command.name === 'number') {
      pair = [this._table[command.name][0], command.value];
    } else {
      pair = [command.name, command.value];
    }

    if (command.index !== -1) {
      if (command.index === Infinity) {
        this._table.push(pair);
      } else {
        this._table.splice(command.index, 1, pair);
      }
      this._enforceSizeBound();           // TODO: The order of these two
      index = this._table.indexOf(pair);  // TODO: operation is not well defined!
    }

    this._working.push({ index: index, pair: pair });
  }
};

// `generateAddCommand` tries to find a compact command (header representation) for the given
// `[name, value]` pair that causes the decoder to add the given pair to the Working Set.
CompressionContext.prototype.generateAddCommand = function(pair) {
  var equal = CompressionContext.equal.bind(null, pair);
  if (this.getWorkingSet().some(equal)) {
    return undefined;
  }

  var working = this._working;
  function shadowed(index) {
    return working.some(function(entry) {
      return entry.index === index;
    });
  }

  var full_match = this._table.filter(equal);
  if (full_match.length !== 0) {
    var full_index = this._table.indexOf(full_match[0]);
    if (!shadowed(full_index)) {
      return {
        name: full_index,
        value: full_index,
        index: -1
      };
    }
  }

  var name = pair[0].toLowerCase();
  var name_match = this._table.filter(function(entry) {
    return entry[0].toLowerCase() === name;
  });
  if (name_match.length !== 0) {
    var name_index = this._table.indexOf(name_match[0]);
    if (!shadowed(name_index)) {
      return {
        name: name_index,
        value: pair[1],
        index: name_index
      };
    }
  }

  return {
    name: name,
    value: pair[1],
    index: Infinity
  };
};

// `generateRemoveCommand` generates a command (header representation) that causes the decoder to
// drop the given pair from the Working Set.
CompressionContext.prototype.generateRemoveCommand = function(pair) {
  for (var i = 0; i < this._working.length; i++) {
    var entry = this._working[i];
    // * if the given header is in the Working Set, then the command is an Indexed Representation.
    if (entry.pair === pair) {
      return {
        name: entry.index,
        value: entry.index,
        index: -1
      };
    }
  }
  // * if the given pair is not in the Working Set, it returns `undefined`
  return undefined;
};

// The header table size can be bounded so as to limit the memory requirements.
// The `_enforceSizeBound()` private method drops the entries that are over the limit
// (`this._limit`).
//
// The header table size is defined as the sum of the size of each entry of the table. The size
// of an entry is the sum of the length in bytes of its name, of value's length in bytes and of
// 32 bytes (for accounting for the entry structure overhead).
CompressionContext.prototype._enforceSizeBound = function() {
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

// [Decompression process](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-3.4)
// =======================

// The decompression process is always done by a `Decompressor` object.
//
// The compression related mutable state is stored in a contained `CompressionContext` object.
// The initial value of it's Header Table depends on which side of the connection is it on.
function Decompressor(type) {
  var initial_table = (type === 'REQUEST') ? CompressionContext.initialRequestTable
                                           : CompressionContext.initialResponseTable;
  this._context = new CompressionContext(initial_table);

  this._initializeStream();
}
Decompressor.prototype = Object.create(Transform.prototype, { constructor: { value: Decompressor } });

// The `decompress` method takes a buffer, and returns the decoded header set.
//
// According to the spec, to ensure a correct decoding of a set of headers, the following steps or
// equivalent ones MUST be executed by the decoder.
Decompressor.prototype.decompress = function decompress(buffer) {
  // * First, upon starting the decoding of a new set of headers, the reference set of headers is
  // interpreted into the working set of headers
  this._context.reinitialize();

  // * Then, the header representations are processed in their order of occurrence in the frame.
  // The decoding process of the header representations are defined in the `execute(command)`
  // method of the `CompressionContext` class.
  buffer.cursor = 0;
  while (buffer.cursor < buffer.length) {
    this._context.execute(Decompressor.header(buffer));
  }

  // * When all the header representations have been processed, the working set contains all the
  // headers of the set of headers.
  var pairs = this._context.getWorkingSet();

  // * The working set entries are `[name, value]` pairs. As a last step, these are converted to the
  // usual header set format used in node.js: `{ name1: value1, name2: [value2, value3], ... }`
  var headers = {};
  for (var i = 0; i < pairs.length; i++) {
    var name = pairs[i][0];
    var value = pairs[i][1];
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

// Compression process
// ===================

// The decompression process is always done by a `Compressor` object.
//
// The compression related mutable state is stored in a contained `CompressionContext` object.
// The initial value of it's Header Table depends on which side of the connection is it on.
function Compressor(type) {
  var initial_table = (type === 'REQUEST') ? CompressionContext.initialRequestTable
                                           : CompressionContext.initialResponseTable;
  this._context = new CompressionContext(initial_table);

  this._initializeStream();
}
Compressor.prototype = Object.create(Transform.prototype, { constructor: { value: Compressor } });

var concat = require('../lib/utils').concat;

// The `compress` method takes a header set and returns an array of buffers containing the
// encoded binary data.
//
// The inverse of the decoding process goes follows:
Compressor.prototype.compress = function compress(headers) {
  var i;

  // * First, the usual node.js header set format (`{ name1: value1, name2: [value2, value3], ... }`)
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

  // * Before generating commands that make the working set equal to the generated pair set,
  // the reference set and the working set has to be reinitialized.
  this._context.reinitialize();
  var working = this._context.getWorkingSet(), command, commands = [];

  // * The first commands remove the unneeded headers from the working set.
  for (i = 0; i < working.length; i++) {
    if (!pairs.some(CompressionContext.equal.bind(null, working[i]))) {
      command = this._context.generateRemoveCommand(working[i]);
      this._context.execute(command);
      commands.push(command);
    }
  }

  // * Then the headers that are not present in the working set yet are added.
  for (i = 0; i < pairs.length; i++) {
    if (!working.some(CompressionContext.equal.bind(null, pairs[i]))) {
      command = this._context.generateAddCommand(pairs[i]);
      this._context.execute(command);
      commands.push(command);
    }
  }

  // * The last step is the serialization of the generated commands.
  var buffers = [];
  for (i = 0; i < commands.length; i++) {
    buffers.push(Compressor.header(commands[i]));
  }

  return concat(Array.prototype.concat.apply([], buffers)); // [[buffers]] -> [buffers] -> buffer
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
  var limit = Math.pow(2,N) - 1;

  var I = buffer[buffer.cursor] & limit;
  if (N !== 0) {
    buffer.cursor += 1;
  }

  if (I === limit) {
    var M = 0;
    do {
      I += (buffer[buffer.cursor] & 127) << M;
      M += 7;
      buffer.cursor += 1;
    } while (buffer[buffer.cursor - 1] & 128);
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
  var encoded_string = new Buffer(str, 'utf8');
  var encoded_length = Compressor.integer(encoded_string.length, 0);
  return encoded_length.concat(encoded_string);
};

Decompressor.string = function readString(buffer) {
  var length = Decompressor.integer(buffer, 0);
  var str = buffer.toString('utf8', buffer.cursor, buffer.cursor + length);
  buffer.cursor += length;
  return str;
};

// [Header represenations](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-00#section-4.3)
// -----------------------

// The JavaScript object representation is described near the
// `CompressionContext.prototype.execute()` method definition.
//
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

var representations = {
  indexed             : { prefix: 7, pattern: 0x80 },
  literal             : { prefix: 5, pattern: 0x60 },
  literal_incremental : { prefix: 5, pattern: 0x40 },
  literal_substitution: { prefix: 6, pattern: 0x00 }
};

Compressor.header = function writeString(header) {
  var representation, buffers = [];

  if (typeof header.value === 'number') {
    representation = representations.indexed;
  } else if (header.index === -1) {
    representation = representations.literal;
  } else if (header.index === Infinity) {
    representation = representations.literal_incremental;
  } else {
    representation = representations.literal_substitution;
  }

  if (representation === representations.indexed) {
    buffers.push(Compressor.integer(header.value, representation.prefix));

  } else {
    if (typeof header.name === 'number') {
      buffers.push(Compressor.integer(header.name + 1, representation.prefix));
    } else {
      buffers.push(Compressor.integer(0, representation.prefix));
      buffers.push(Compressor.string(header.name));
    }

    if (representation === representations.literal_substitution) {
      buffers.push(Compressor.integer(header.index, 0));
    }

    buffers.push(Compressor.string(header.value));
  }

  buffers[0][0][0] |= representation.pattern;

  return Array.prototype.concat.apply([], buffers); // array of arrays of buffers -> array of buffers
};

Decompressor.header = function readString(buffer) {
  var representation, header = {};

  var first_byte = buffer[buffer.cursor];
  if (first_byte & 0x80) {
    representation = representations.indexed;
  } else if (first_byte & 0x40) {
    if (first_byte & 0x20) {
      representation = representations.literal;
    } else {
      representation = representations.literal_incremental;
    }
  } else {
    representation = representations.literal_substitution;
  }

  if (representation === representations.indexed) {
    header.value = header.name = Decompressor.integer(buffer, representation.prefix);
    header.index = -1;

  } else {
    header.name = Decompressor.integer(buffer, representation.prefix) - 1;
    if (header.name === -1) {
      header.name = Decompressor.string(buffer);
    }

    if (representation === representations.literal_substitution) {
      header.index = Decompressor.integer(buffer, 0);
    } else if (representation === representations.literal_incremental) {
      header.index = Infinity;
    } else {
      header.index = -1;
    }

    header.value = Decompressor.string(buffer);
  }

  return header;
};

// The compression layer
// =====================

// This section describes the interaction between the compressor/decompressor and the rest of the
// HTTP/2 implementation. The Compressor and the Decompressor makes up a layer between the
// [framer](framer.html) and the [connection handling component](connection.html). They let most
// frames pass through, except HEADERS and PUSH_PROMISE frames. They convert the frames between
// these two representations:
//
//     {                                   {
//      type: 'HEADERS',                    type: 'HEADERS',
//      flags: {},                          flags: {},
//      stream: 1,               <===>      stream: 1,
//      headers: {                          data: Buffer
//       N1: 'V1',                         }
//       N2: ['V1', 'V2', ...],
//       // ...
//      }
//     }
//
// There are possibly several binary frame that belong to a single non-binary frame.

var MAX_HTTP_PAYLOAD_SIZE = 16383;

// The Compressor transform stream is basically stateless.
Compressor.prototype._initializeStream = function _initializeStream() {
  Transform.call(this, { objectMode: true });
};

Compressor.prototype._transform = function _transform(frame, encoding, done) {
  // When it receives a HEADERS or PUSH_PROMISE frame
  if (frame.type === 'HEADERS' || frame.type === 'PUSH_PROMISE') {
    // * it generates a header block using the compress method
    var buffer = this.compress(frame.headers);

    // * splits the header block into `chunk`s that are not larger than `MAX_HTTP_PAYLOAD_SIZE`
    var cursor = 0;
    do {
      var chunk_size = Math.min(MAX_HTTP_PAYLOAD_SIZE, buffer.length);
      var chunk = buffer.slice(cursor, cursor + chunk_size);
      cursor += chunk_size;

      // * for each `chunk`, it generates a `chunk_frame` that is identical to the original, except
      // the `data` property which holds the given chunk
      var chunk_frame = {
        type: frame.type,
        flags: frame.flags,
        stream: frame.stream,
        priority: frame.priority,
        data: chunk
      };

      // * sets the END_HEADERS or END_PUSH_STREAM flag to true if it's the last chunk
      chunk_frame.flags['END_' + frame.type] = (cursor === buffer.length);

      // * and pushes out the `chunk_frame`
      this.push(chunk_frame);

    } while (!end);
  }

  done();
};

// The Decompressor is a stateful transform stream, since it has to collect multiple frames first,
// and the decoding comes after unifying the payload of those frames.
//
// If there's a frame in progress, `this._in_progress` is `true`. The frames are collected in
// `this._frames`, and the type of the frame and the stream identifier is stored in `this._type`
// and `this._stream` respectively.
Decompressor.prototype._initializeStream = function _initializeStream() {
  Transform.call(this, { objectMode: true });
  this._in_progress = false;
  this._type = undefined;
  this._stream = undefined;
  this._frames = undefined;
};

// When a `frame` arrives
Decompressor.prototype._transform = function _transform(frame, encoding, done) {
  // * and the collection process is already `_in_progress`, the frame is simply stored, except if
  // it's an illegal frame
  if (this._in_progress) {
    if (frame.type !== this._type || frame.stream !== this._stream) {
      throw new Error('A series of header frames must not be interleaved with other frames!');
    }
    this._frames.push(frame);
  }

  // * and the collection process is not `_in_progress`, but the new frame's type is HEADERS or
  // PUSH_PROMISE, a new collection process begins
  else if (frame.type === 'HEADERS' || frame.type === 'PUSH_PROMISE') {
    this._in_progress = true;
    this._type = frame.type;
    this._stream = frame.stream;
    this._frames = [frame];
  }

  // * otherwise, the frame is forwarded without taking any action
  else {
    this.push(frame);
  }

  // When the frame signals that it's the last in the series, the header block chunks are
  // concatenated, the headers are decompressed, and a new frame gets pushed out with the
  // decompressed headers.
  if (this._in_progress && (frame.flags.END_HEADERS || frame.flags.END_PUSH_PROMISE)) {
    var buffer = concat(this._frames.map(function(frame) {
      return frame.data;
    }));
    var headers = this.decompress(buffer);
    this.push({
      type: frame.type,
      flags: frame.flags,
      stream: frame.stream,
      priority: frame.priority,
      headers: headers
    });
    this._in_progress = false;
  }

  done();
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
