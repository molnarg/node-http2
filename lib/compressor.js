// The implementation of the [HTTP/2 Header Compression][http2-compression] spec is separated from
// the 'integration' part which handles HEADERS and PUSH_PROMISE frames. The compression itself is
// implemented in the first part of the file, and consists of three classes: `HeaderTable`,
// `HeaderSetDecompressor` and `HeaderSetCompressor`. The two latter classes are
// [Transform Stream][node-transform] subclasses that operate in [object mode][node-objectmode].
// These transform chunks of binary data into `[name, value]` pairs and vice versa, and store their
// state in `HeaderTable` instances.
//
// The 'integration' part is also implemented by two [Transform Stream][node-transform] subclasses
// that operate in [object mode][node-objectmode]: the `Compressor` and the `Decompressor`. These
// provide a layer between the [framer](framer.html) and the
// [connection handling component](connection.html).
//
// [node-transform]: http://nodejs.org/api/stream.html#stream_class_stream_transform
// [node-objectmode]: http://nodejs.org/api/stream.html#stream_new_stream_readable_options
// [http2-compression]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03

exports.HeaderTable = HeaderTable;
exports.HeaderSetCompressor = HeaderSetCompressor;
exports.HeaderSetDecompressor = HeaderSetDecompressor;
exports.Compressor = Compressor;
exports.Decompressor = Decompressor;

var TransformStream = require('stream').Transform;
var assert = process.env.HTTP2_ASSERT ? require('assert') : function noop() {};
var util = require('util');

// Header compression
// ==================

// The HeaderTable class
// ---------------------

// The [Header Table][headertable] is a component used to associate headers to index values. It is
// basically an ordered list of `[name, value]` pairs, so it's implemented as a subclass of `Array`.
// [headertable]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-3.1.2
function HeaderTable(log, table, limit) {
  var self = table.map(entryFromPair);
  self._log = log;
  self._limit = limit || DEFAULT_HEADER_TABLE_LIMIT;
  self._size = tableSize(self);
  self.add = HeaderTable.prototype.add;
  return self;
}

// There are few more sets that are needed for the compression/decompression process that are all
// subsets of the Header Table, and are implemented as flags on header table entries:
//
// * [Reference Set][referenceset]: contains a group of headers used as a reference for the
//   differential encoding of a new set of headers. (`reference` flag)
// * Emitted headers: the headers that are already emitted as part of the current decompression
//   process (not part of the spec, `emitted` flag)
// * Headers to be kept: headers that should not be removed as the last step of the encoding process
//   (not part of the spec, `keep` flag)
//
// [referenceset]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-3.1.3
function entryFromPair(pair) {
  var entry = pair.slice();
  entry.reference = false;
  entry.emitted = false;
  entry.keep = false;
  entry._size = size(entry);
  return entry;
}

// The encoder decides how to update the header table and as such can control how much memory is
// used by the header table.  To limit the memory requirements on the decoder side, the header table
// size is bounded.
//
// * The default header table size limit is 4096 bytes.
// * The size of an entry is defined as follows: the size of an entry is the sum of its name's
//   length in bytes, of its value's length in bytes and of 32 bytes.
// * The size of a header table is the sum of the size of its entries.
var DEFAULT_HEADER_TABLE_LIMIT = 4096;

function size(entry) {
  return new Buffer(entry[0] + entry[1], 'utf8').length + 32;
}

function tableSize(table) {
  var size = 0;
  for (var i = 0; i < table.length; i++) {
    size += table[i]._size;
  }
  return size;
}

// The `add(index, entry)` can be used to [manage the header table][tablemgmt]:
// [tablemgmt]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-3.2.4
//
// * if `index` is `Infinite` it pushes the new `entry` at the end of the table
// * otherwise, it replaces the entry with the given `index` with the new `entry`
// * before doing such a modification, it has to be ensured that the header table size will stay
//   lower than or equal to the header table size limit. To achieve this, repeatedly, the first
//   entry of the header table is removed, until enough space is available for the modification.
HeaderTable.prototype.add = function(index, entry) {
  var limit = this._limit - entry._size;
  while ((this._size > limit) && (this.length > 0)) {
    var dropped = this.shift();
    this._size -= dropped._size;
    index -= 1;
  }

  if (this._size <= limit) {
    if (index < 0) {
      this.unshift(entry);
    } else {
      this.splice(index, 1, entry); // this is like push() if index is Infinity
    }
    this._size += entry._size;
  }
};

// Initial header tables
// ---------------------

// ### [Initial request table][requesttable] ###
// [requesttable]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#appendix-B.1
HeaderTable.initialRequestTable  = [
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
  [ 'user-agent'                  , ''      ],
  [ 'referer'                     , ''      ],
  [ 'authorization'               , ''      ],
  [ 'allow'                       , ''      ],
  [ 'cache-control'               , ''      ],
  [ 'connection'                  , ''      ],
  [ 'content-length'              , ''      ],
  [ 'content-type'                , ''      ],
  [ 'date'                        , ''      ],
  [ 'expect'                      , ''      ],
  [ 'from'                        , ''      ],
  [ 'if-match'                    , ''      ],
  [ 'if-none-match'               , ''      ],
  [ 'if-range'                    , ''      ],
  [ 'if-unmodified-since'         , ''      ],
  [ 'max-forwards'                , ''      ],
  [ 'proxy-authorization'         , ''      ],
  [ 'range'                       , ''      ],
  [ 'via'                         , ''      ]
];

// ### [Initial response table][responsetable] ###
// [responsetable]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#appendix-B.2
HeaderTable.initialResponseTable = [
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
  [ 'content-range'               , ''      ],
  [ 'link'                        , ''      ],
  [ 'location'                    , ''      ],
  [ 'proxy-authenticate'          , ''      ],
  [ 'refresh'                     , ''      ],
  [ 'retry-after'                 , ''      ],
  [ 'strict-transport-security'   , ''      ],
  [ 'transfer-encoding'           , ''      ],
  [ 'www-authenticate'            , ''      ]
];

// The HeaderSetDecompressor class
// -------------------------------

// A `HeaderSetDecompressor` instance is a transform stream that can be used to *decompress a
// single header set*. Its input is a stream of binary data chunks and its output is a stream of
// `[name, value]` pairs.
//
// Currently, it is not a proper streaming decompressor implementation, since it buffer its input
// until the end os the stream, and then processes the whole header block at once.

util.inherits(HeaderSetDecompressor, TransformStream);
function HeaderSetDecompressor(log, table) {
  TransformStream.call(this, { objectMode: true });

  this._log = log.child({ component: 'compressor' });
  this._table = table;
  this._chunks = [];
}

// `_transform` is the implementation of the [corresponding virtual function][_transform] of the
// TransformStream class. It collects the data chunks for later processing.
// [_transform]: http://nodejs.org/api/stream.html#stream_transform_transform_chunk_encoding_callback
HeaderSetDecompressor.prototype._transform = function _transform(chunk, encoding, callback) {
  this._chunks.push(chunk);
  callback();
};

// `execute(rep)` executes the given [header representation][representation].
// [representation]: http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-3.1.5

// The *JavaScript object representation* of a header representation:
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
HeaderSetDecompressor.prototype._execute = function _execute(rep) {
  this._log.trace({ key: rep.name, value: rep.value, index: rep.index },
                  'Executing a header representation');

  var index, entry, pair;

  // * An _indexed representation_ corresponding to an entry _present_ in the reference set
  //   entails the following actions:
  //   * The entry is removed from the reference set.
  // * An _indexed representation_ corresponding to an entry _not present_ in the reference set
  //   entails the following actions:
  //   * The header corresponding to the entry is emitted.
  //   * The entry is added to the reference set.
  if (typeof rep.value === 'number') {
    index = rep.value;
    entry = this._table[index];

    if (entry.reference) {
      entry.reference = false;
    } else {
      entry.reference = true;
      entry.emitted = true;
      pair = entry.slice();
      this.push(pair);
    }
  }

  // * A _literal representation_ that is _not added_ to the header table entails the following
  //   action:
  //   * The header is emitted.
  // * A _literal representation_ that is _added_ to the header table entails the following further
  //   actions:
  //   * The header is added to the header table, at the location defined by the representation.
  //   * The new entry is added to the reference set.
  else {
    if (typeof rep.name === 'number') {
      pair = [this._table[rep.name][0], rep.value];
    } else {
      pair = [rep.name, rep.value];
    }

    index = rep.index;
    if (index !== -1) {
      entry = entryFromPair(pair);
      entry.reference = true;
      entry.emitted = true;
      this._table.add(index, entry);
    }

    this.push(pair);
  }
};

// `_flush` is the implementation of the [corresponding virtual function][_flush] of the
// TransformStream class. The whole decompressing process is done in `_flush`. It gets called when
// the input stream is over.
// [_flush]: http://nodejs.org/api/stream.html#stream_transform_flush_callback
HeaderSetDecompressor.prototype._flush = function _flush(callback) {
  var buffer = concat(this._chunks);

  // * processes the header representations
  buffer.cursor = 0;
  while (buffer.cursor < buffer.length) {
    this._execute(HeaderSetDecompressor.header(buffer));
  }

  // * [emits the reference set](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-3.2.2)
  for (var index = 0; index < this._table.length; index++) {
    var entry = this._table[index];
    if (entry.reference && !entry.emitted) {
      this.push(entry.slice());
    }
    entry.emitted = false;
  }

  callback();
};

// The HeaderSetCompressor class
// -----------------------------

// A `HeaderSetCompressor` instance is a transform stream that can be used to *compress a single
// header set*. Its input is a stream of `[name, value]` pairs and its output is a stream of
// binary data chunks.
//
// It is a real streaming compressor, since it does not wait until the header set is complete.
//
// The compression algorithm is (intentionally) not specified by the spec. Therefore, the current
// compression algorithm can probably be improved in the future.

util.inherits(HeaderSetCompressor, TransformStream);
function HeaderSetCompressor(log, table) {
  TransformStream.call(this, { objectMode: true });

  this._log = log.child({ component: 'compressor' });
  this._table = table;
}

// `_transform` is the implementation of the [corresponding virtual function][_transform] of the
// TransformStream class. It processes the input headers one by one:
// [_transform]: http://nodejs.org/api/stream.html#stream_transform_transform_chunk_encoding_callback
HeaderSetCompressor.prototype._transform = function _transform(pair, encoding, callback) {
  var name = pair[0].toLowerCase();
  var value = pair[1];
  var entry, rep;

  // * tries to find full (name, value) or name match in the header table
  var nameMatch = -1, fullMatch = -1;
  for (var index = 0; index < this._table.length; index++) {
    entry = this._table[index];
    if (entry[0] === name) {
      if (entry[1] === value) {
        fullMatch = index;
        break;
      } else if (nameMatch === -1) {
        nameMatch = index;
      }
    }
  }

  // * if there's full match, it will be an indexed representation (or more than one) depending
  //   on its presence in the reference, the emitted and the keep set
  if (fullMatch !== -1) {
    rep = concat(HeaderSetCompressor.header({ name: fullMatch, value: fullMatch, index: -1 }));

    if (!entry.reference) {
      this.push(rep);
      entry.reference = true;
      entry.emitted = true;
    }

    else if (entry.keep) {
      this.push(rep);
      this.push(rep);
      this.push(rep);
      this.push(rep);
      entry.keep = false;
      entry.emitted = true;
    }

    else if (entry.emitted) {
      this.push(rep);
      this.push(rep);
    }

    else {
      entry.keep = true;
    }
  }

  // * otherwise, it will be a literal representation (with a name index if there's a name match)
  else {
    var insertIndex = Infinity;
    if (nameMatch !== -1) {
      name = nameMatch;
      insertIndex = nameMatch;
    }

    rep = concat(HeaderSetCompressor.header({ name: name, value: value, index: insertIndex }));
    this.push(rep);

    entry = entryFromPair(pair);
    entry.reference = true;
    entry.emitted = true;
    this._table.add(insertIndex, entry);
  }

  callback();
};

// `_flush` is the implementation of the [corresponding virtual function][_flush] of the
// TransformStream class. It gets called when there's no more header to compress. The final step:
// [_flush]: http://nodejs.org/api/stream.html#stream_transform_flush_callback
HeaderSetCompressor.prototype._flush = function _flush(callback) {
  // * removing entries from the header set that are not marked to be kept
  for (var index = 0; index < this._table.length; index++) {
    var entry = this._table[index];
    if (entry.reference && !entry.keep) {
      var rep = concat(HeaderSetCompressor.header({ name: index, value: index, index: -1 }));
      this.push(rep);
      entry.reference = false;
    }
    entry.keep = false;
    entry.emitted = false;
  }

  callback();
};

// [Detailed Format](http://tools.ietf.org/html/draft-ietf-httpbis-header-compression-03#section-4)
// -----------------

// ### Integer representation ###
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

HeaderSetCompressor.integer = function writeInteger(I, N) {
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

HeaderSetDecompressor.integer = function readInteger(buffer, N) {
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

// ### String literal representation ###
//
// Literal **strings** can represent header names or header values.  They are encoded in two parts:
//
// 1. The string length, defined as the number of bytes needed to store its UTF-8 representation,
//    is represented as an integer with a zero bits prefix.  If the string length is strictly less
//    than 128, it is represented as one byte.
// 2. The string value represented as a list of UTF-8 characters.

HeaderSetCompressor.string = function writeString(str) {
  var encodedString = new Buffer(str, 'utf8');
  var encodedLength = HeaderSetCompressor.integer(encodedString.length, 0);
  return encodedLength.concat(encodedString);
};

HeaderSetDecompressor.string = function readString(buffer) {
  var length = HeaderSetDecompressor.integer(buffer, 0);
  var str = buffer.toString('utf8', buffer.cursor, buffer.cursor + length);
  buffer.cursor += length;
  return str;
};

// ### Header represenations ###

// The JavaScript object representation is described near the
// `HeaderTable.prototype.execute()` method definition.
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
  literalIncremental  : { prefix: 5, pattern: 0x40 },
  literalSubstitution : { prefix: 6, pattern: 0x00 }
};

HeaderSetCompressor.header = function writeHeader(header) {
  var representation, buffers = [];

  if (typeof header.value === 'number') {
    representation = representations.indexed;
  } else if (header.index === -1) {
    representation = representations.literal;
  } else if (header.index === Infinity) {
    representation = representations.literalIncremental;
  } else {
    representation = representations.literalSubstitution;
  }

  if (representation === representations.indexed) {
    buffers.push(HeaderSetCompressor.integer(header.value, representation.prefix));

  } else {
    if (typeof header.name === 'number') {
      buffers.push(HeaderSetCompressor.integer(header.name + 1, representation.prefix));
    } else {
      buffers.push(HeaderSetCompressor.integer(0, representation.prefix));
      buffers.push(HeaderSetCompressor.string(header.name));
    }

    if (representation === representations.literalSubstitution) {
      buffers.push(HeaderSetCompressor.integer(header.index, 0));
    }

    buffers.push(HeaderSetCompressor.string(header.value));
  }

  buffers[0][0][0] |= representation.pattern;

  return Array.prototype.concat.apply([], buffers); // array of arrays of buffers -> array of buffers
};

HeaderSetDecompressor.header = function readHeader(buffer) {
  var representation, header = {};

  var firstByte = buffer[buffer.cursor];
  if (firstByte & 0x80) {
    representation = representations.indexed;
  } else if (firstByte & 0x40) {
    if (firstByte & 0x20) {
      representation = representations.literal;
    } else {
      representation = representations.literalIncremental;
    }
  } else {
    representation = representations.literalSubstitution;
  }

  if (representation === representations.indexed) {
    header.value = header.name = HeaderSetDecompressor.integer(buffer, representation.prefix);
    header.index = -1;

  } else {
    header.name = HeaderSetDecompressor.integer(buffer, representation.prefix) - 1;
    if (header.name === -1) {
      header.name = HeaderSetDecompressor.string(buffer);
    }

    if (representation === representations.literalSubstitution) {
      header.index = HeaderSetDecompressor.integer(buffer, 0);
    } else if (representation === representations.literalIncremental) {
      header.index = Infinity;
    } else {
      header.index = -1;
    }

    header.value = HeaderSetDecompressor.string(buffer);
  }

  return header;
};

// Integration with HTTP/2
// =======================

// This section describes the interaction between the compressor/decompressor and the rest of the
// HTTP/2 implementation. The `Compressor` and the `Decompressor` makes up a layer between the
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

// The Compressor class
// --------------------

// The Compressor transform stream is basically stateless.
util.inherits(Compressor, TransformStream);
function Compressor(type, log) {
  TransformStream.call(this, { objectMode: true });

  this._log = log.child({ component: 'compressor' });

  assert((type === 'REQUEST') || (type === 'RESPONSE'));
  var initialTable = (type === 'REQUEST') ? HeaderTable.initialRequestTable
                                          : HeaderTable.initialResponseTable;
  this._table = new HeaderTable(this._log, initialTable);
}

// `compress` takes a header set, and compresses it using a new `HeaderSetCompressor` stream
// instance. This means that from now on, the advantages of streaming header encoding are lost,
// but the API becomes simpler.
Compressor.prototype.compress = function compress(headers) {
  var compressor = new HeaderSetCompressor(this._log, this._table);
  for (var name in headers) {
    var value = headers[name];
    if (value instanceof Array) {
      for (var i = 0; i< value.length; i++) {
        compressor.write([String(name), String(value[i])]);
      }
    } else {
      compressor.write([String(name), String(value)]);
    }
  }
  compressor.end();

  var chunk, chunks = [];
  while (chunk = compressor.read()) {
    chunks.push(chunk);
  }
  return concat(chunks);
};

// When a `frame` arrives
Compressor.prototype._transform = function _transform(frame, encoding, done) {
  // * and it is a HEADERS or PUSH_PROMISE frame
  //   * it generates a header block using the compress method
  //   * cuts the header block into `chunks` that are not larger than `MAX_HTTP_PAYLOAD_SIZE`
  //   * for each chunk, it pushes out a chunk frame that is identical to the original, except
  //     the `data` property which holds the given chunk, the END_HEADERS/END_PUSH_STREAM flag that
  //     marks the last frame and the END_STREAM flag which is always false before the end
  if (frame.type === 'HEADERS' || frame.type === 'PUSH_PROMISE') {
    var buffer = this.compress(frame.headers);

    var chunks = cut(buffer, MAX_HTTP_PAYLOAD_SIZE);

    for (var i = 0; i < chunks.length; i++) {
      var flags = util._extend({}, frame.flags);
      if (i === chunks.length - 1) {
        flags['END_' + frame.type] = true;
      } else {
        flags['END_' + frame.type] = false;
        flags['END_STREAM'] = false;
      }

      this.push({
        type: frame.type,
        flags: flags,
        stream: frame.stream,
        priority: frame.priority,
        promised_stream: frame.promised_stream,
        data: chunks[i]
      });
    }
  }

  // * otherwise, the frame is forwarded without taking any action
  else {
    this.push(frame);
  }

  done();
};

// The Decompressor class
// ----------------------

// The Decompressor is a stateful transform stream, since it has to collect multiple frames first,
// and the decoding comes after unifying the payload of those frames.
//
// If there's a frame in progress, `this._inProgress` is `true`. The frames are collected in
// `this._frames`, and the type of the frame and the stream identifier is stored in `this._type`
// and `this._stream` respectively.
util.inherits(Decompressor, TransformStream);
function Decompressor(type, log) {
  TransformStream.call(this, { objectMode: true });

  this._log = log.child({ component: 'compressor' });

  assert((type === 'REQUEST') || (type === 'RESPONSE'));
  var initialTable = (type === 'REQUEST') ? HeaderTable.initialRequestTable
                                          : HeaderTable.initialResponseTable;
  this._table = new HeaderTable(this._log, initialTable);

  this._inProgress = false;
  this._type = undefined;
  this._stream = undefined;
  this._frames = undefined;
}

// `decompress` takes a full header block, and decompresses it using a new `HeaderSetDecompressor`
// stream instance. This means that from now on, the advantages of streaming header decoding are
// lost, but the API becomes simpler.
Decompressor.prototype.decompress = function decompress(block) {
  var decompressor = new HeaderSetDecompressor(this._log, this._table);
  decompressor.end(block);

  var headers = {};
  var pair;
  while (pair = decompressor.read()) {
    var name = pair[0];
    var value = pair[1];
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

// When a `frame` arrives
Decompressor.prototype._transform = function _transform(frame, encoding, done) {
  // * and the collection process is already `_inProgress`, the frame is simply stored, except if
  // it's an illegal frame
  if (this._inProgress) {
    if ((frame.type !== this._type) || (frame.stream !== this._stream)) {
      this._log.error('A series of HEADER frames were not continuous');
      this.emit('error', 'PROTOCOL_ERROR');
      return;
    }
    this._frames.push(frame);
  }

  // * and the collection process is not `_inProgress`, but the new frame's type is HEADERS or
  // PUSH_PROMISE, a new collection process begins
  else if ((frame.type === 'HEADERS') || (frame.type === 'PUSH_PROMISE')) {
    this._inProgress = true;
    this._type = frame.type;
    this._stream = frame.stream;
    this._frames = [frame];
  }

  // * otherwise, the frame is forwarded without taking any action
  else {
    this.push(frame);
  }

  // * When the frame signals that it's the last in the series, the header block chunks are
  //   concatenated, the headers are decompressed, and a new frame gets pushed out with the
  //   decompressed headers.
  if (this._inProgress && (frame.flags.END_HEADERS || frame.flags.END_PUSH_PROMISE)) {
    var buffer = concat(this._frames.map(function(frame) {
      return frame.data;
    }));
    try {
      var headers = this.decompress(buffer);
    } catch(error) {
      this._log.error({ err: error }, 'Header decompression error');
      this.emit('error', 'COMPRESSION_ERROR');
      return;
    }
    this.push({
      type: frame.type,
      flags: frame.flags,
      stream: frame.stream,
      priority: frame.priority,
      promised_stream: frame.promised_stream,
      headers: headers
    });
    this._inProgress = false;
  }

  done();
};

// Helper functions
// ================

// Concatenate an array of buffers into a new buffer
function concat(buffers) {
  var size = 0;
  for (var i = 0; i < buffers.length; i++) {
    size += buffers[i].length;
  }

  var concatenated = new Buffer(size);
  for (var cursor = 0, j = 0; j < buffers.length; cursor += buffers[j].length, j++) {
    buffers[j].copy(concatenated, cursor);
  }

  return concatenated;
}

// Cut `buffer` into chunks not larger than `size`
function cut(buffer, size) {
  var chunks = [];
  var cursor = 0;
  do {
    var chunkSize = Math.min(size, buffer.length - cursor);
    chunks.push(buffer.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  } while(cursor < buffer.length);
  return chunks;
}
