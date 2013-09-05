var expect = require('chai').expect;
var util = require('./util');

var compressor = require('../lib/compressor');
var HeaderTable = compressor.HeaderTable;
var HeaderSetCompressor = compressor.HeaderSetCompressor;
var HeaderSetDecompressor = compressor.HeaderSetDecompressor;
var Compressor = compressor.Compressor;
var Decompressor = compressor.Decompressor;

var test_integers = [{
  N: 5,
  I: 10,
  buffer: new Buffer([10])
}, {
  N: 0,
  I: 10,
  buffer: new Buffer([10])
}, {
  N: 5,
  I: 1337,
  buffer: new Buffer([31, 128 + 26, 10])
}, {
  N: 0,
  I: 1337,
  buffer: new Buffer([128 + 57, 10])
}];

var test_strings = [{
  string: 'abcdefghij',
  buffer: new Buffer('0A6162636465666768696A', 'hex')
}, {
  string: 'éáűőúöüó€',
  buffer: new Buffer('13C3A9C3A1C5B1C591C3BAC3B6C3BCC3B3E282AC', 'hex')
}];

var test_headers = [{
  header: {
    name: 3,
    value: '/my-example/index.html',
    index: Infinity
  },
  buffer: new Buffer('44' + '162F6D792D6578616D706C652F696E6465782E68746D6C', 'hex')
}, {
  header: {
    name: 11,
    value: 'my-user-agent',
    index: Infinity
  },
  buffer: new Buffer('4C' + '0D6D792D757365722D6167656E74', 'hex')
}, {
  header: {
    name: 'x-my-header',
    value: 'first',
    index: Infinity
  },
  buffer: new Buffer('40' + '0B782D6D792D686561646572' + '056669727374', 'hex')
}, {
  header: {
    name: 30,
    value: 30,
    index: -1
  },
  buffer: new Buffer('9e', 'hex')
}, {
  header: {
    name: 32,
    value: 32,
    index: -1
  },
  buffer: new Buffer('a0', 'hex')
}, {
  header: {
    name: 3,
    value: '/my-example/resources/script.js',
    index: 30
  },
  buffer: new Buffer('041e' + '1F2F6D792D6578616D706C652F7265736F75726365732F7363726970742E6A73', 'hex')
}, {
  header: {
    name: 32,
    value: 'second',
    index: Infinity
  },
  buffer: new Buffer('5F02' + '067365636F6E64', 'hex')
}, {
  header: {
    name: 32,
    value: 'third',
    index: -1
  },
  buffer: new Buffer('7F02' + '057468697264', 'hex')
}];

var test_header_sets = [{
  headers: {
    ':path': '/my-example/index.html',
    'user-agent': 'my-user-agent',
    'x-my-header': 'first'
  },
  buffer: util.concat(test_headers.slice(0, 3).map(function(test) { return test.buffer; }))
}, {
  headers: {
    ':path': '/my-example/resources/script.js',
    'user-agent': 'my-user-agent',
    'x-my-header': 'second'
  },
  buffer: util.concat(test_headers.slice(3, 7).map(function(test) { return test.buffer; }))
}, {
  headers: {
    ':path': '/my-example/resources/script.js',
    'user-agent': 'my-user-agent',
    'x-my-header': ['third', 'second']
  },
  buffer: test_headers[7].buffer
}, {
  headers: {
    ':status': '200',
    'user-agent': 'my-user-agent',
    'cookie': ['first', 'second', 'third', 'third'],
    'verylong': (new Buffer(9000)).toString('hex')
  }
}];

describe('compressor.js', function() {
  describe('HeaderTable', function() {
  });

  describe('HeaderSetCompressor', function() {
    describe('static method .integer(I, N)', function() {
      it('should return an array of buffers that represent the N-prefix coded form of the integer I', function() {
        for (var i = 0; i < test_strings.length; i++) {
          var test = test_strings[i];
          expect(util.concat(HeaderSetCompressor.string(test.string))).to.deep.equal(test.buffer);
        }
      });
    });
    describe('static method .string(string)', function() {
      it('should return an array of buffers that represent the encoded form of the string', function() {
        for (var i = 0; i < test_strings.length; i++) {
          var test = test_strings[i];
          expect(util.concat(HeaderSetCompressor.string(test.string))).to.deep.equal(test.buffer);
        }
      });
    });
    describe('static method .header({ name, value, indexing, substitution })', function() {
      it('should return an array of buffers that represent the encoded form of the header', function() {
        for (var i = 0; i < test_headers.length; i++) {
          var test = test_headers[i];
          expect(util.concat(HeaderSetCompressor.header(test.header))).to.deep.equal(test.buffer);
        }
      });
    });
  });

  describe('HeaderSetDecompressor', function() {
    describe('static method .integer(buffer, N)', function() {
      it('should return the parsed N-prefix coded number and increase the cursor property of buffer', function() {
        for (var i = 0; i < test_integers.length; i++) {
          var test = test_integers[i];
          test.buffer.cursor = 0;
          expect(HeaderSetDecompressor.integer(test.buffer, test.N)).to.equal(test.I);
          expect(test.buffer.cursor).to.equal(test.buffer.length);
        }
      });
    });
    describe('static method .string(buffer)', function() {
      it('should return the parsed string and increase the cursor property of buffer', function() {
        for (var i = 0; i < test_strings.length; i++) {
          var test = test_strings[i];
          test.buffer.cursor = 0;
          expect(HeaderSetDecompressor.string(test.buffer)).to.equal(test.string);
          expect(test.buffer.cursor).to.equal(test.buffer.length);
        }
      });
    });
    describe('static method .header(buffer)', function() {
      it('should return the parsed header and increase the cursor property of buffer', function() {
        for (var i = 0; i < test_headers.length; i++) {
          var test = test_headers[i];
          test.buffer.cursor = 0;
          expect(HeaderSetDecompressor.header(test.buffer)).to.deep.equal(test.header);
          expect(test.buffer.cursor).to.equal(test.buffer.length);
        }
      });
    });
  });
  describe('Decompressor', function() {
    describe('method decompress(buffer)', function() {
      it('should return the parsed header set in { name1: value1, name2: [value2, value3], ... } format', function() {
        var decompressor = new Decompressor('REQUEST', util.log);
        var header_set = test_header_sets[0];
        expect(decompressor.decompress(header_set.buffer)).to.deep.equal(header_set.headers);
        header_set = test_header_sets[1];
        expect(decompressor.decompress(header_set.buffer)).to.deep.equal(header_set.headers);
        header_set = test_header_sets[2];
        expect(decompressor.decompress(header_set.buffer)).to.deep.equal(header_set.headers);
      });
    });
    describe('transform stream', function() {
      it('should emit an error event if a series of header frames is interleaved with other frames', function() {
        var decompressor = new Decompressor('REQUEST', util.log);
        var error_occured = false;
        decompressor.on('error', function() {
          error_occured = true;
        });
        decompressor.write({
          type: 'HEADERS',
          flags: {
            END_HEADERS: false
          },
          data: new Buffer(5)
        });
        decompressor.write({
          type: 'DATA',
          flags: {},
          data: new Buffer(5)
        });
        expect(error_occured).to.be.equal(true);
      });
    });
  });

  describe('invariant', function() {
    describe('decompressor.decompress(compressor.compress(headerset)) === headerset', function() {
      it('should be true for any header set if the states are synchronized', function() {
        var compressor = new Compressor('REQUEST', util.log);
        var decompressor = new Decompressor('REQUEST', util.log);
        for (var i = 0; i < 10; i++) {
          var headers = test_header_sets[i%4].headers;
          var compressed = compressor.compress(headers);
          var decompressed = decompressor.decompress(compressed);
          expect(headers).to.deep.equal(decompressed);
          expect(compressor._table).to.deep.equal(decompressor._table);
        }
      });
    });
    describe('source.pipe(compressor).pipe(decompressor).pipe(destination)', function() {
      it('should behave like source.pipe(destination) for a stream of frames', function(done) {
        var compressor = new Compressor('RESPONSE', util.log);
        var decompressor = new Decompressor('RESPONSE', util.log);
        compressor.pipe(decompressor);
        for (var i = 0; i < 10; i++) {
          compressor.write({
            type: i%2 ? 'HEADERS' : 'PUSH_PROMISE',
            flags: {},
            headers: test_header_sets[i%4].headers
          });
        }
        setTimeout(function() {
          for (var j = 0; j < 10; j++) {
            expect(decompressor.read().headers).to.deep.equal(test_header_sets[j%4].headers);
          }
          done();
        }, 10);
      });
    });
  });
});
