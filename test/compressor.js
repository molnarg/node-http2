var expect = require('chai').expect

var compressor = require('../lib/compressor')
  , Compressor = compressor.Compressor
  , Decompressor = compressor.Decompressor

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
}]

var test_strings = [{
  string: 'abcdefghij',
  buffer: new Buffer('0A6162636465666768696A', 'hex')
}, {
  string: 'éáűőúöüó€',
  buffer: new Buffer('13C3A9C3A1C5B1C591C3BAC3B6C3BCC3B3E282AC', 'hex')
}]

var test_headers = [{
  header: {
    name: 3,
    value: '/my-example/index.html',
    indexing: true
  },
  buffer: new Buffer('44' + '162F6D792D6578616D706C652F696E6465782E68746D6C', 'hex')
}, {
  header: {
    name: 12,
    value: 'my-user-agent',
    indexing: true
  },
  buffer: new Buffer('4D' + '0D6D792D757365722D6167656E74', 'hex')
}, {
  header: {
    name: 'x-my-header',
    value: 'first',
    indexing: true
  },
  buffer: new Buffer('40' + '0B782D6D792D686561646572' + '056669727374', 'hex')
}, {
  header: {
    name: 38,
    value: 38,
    indexing: false
  },
  buffer: new Buffer('A6', 'hex')
}, {
  header: {
    name: 40,
    value: 40,
    indexing: false
  },
  buffer: new Buffer('A8', 'hex')
}, {
  header: {
    name: 3,
    value: '/my-example/resources/script.js',
    indexing: true,
    substitution: 38
  },
  buffer: new Buffer('0426' + '1F2F6D792D6578616D706C652F7265736F75726365732F7363726970742E6A73', 'hex')
}, {
  header: {
    name: 40,
    value: 'second',
    indexing: true
  },
  buffer: new Buffer('5F0A' + '067365636F6E64', 'hex')
}]

// Concatenate buffers into a new buffer
function concat(buffers) {
  var size = 0
  for (var i = 0; i < buffers.length; i++) size += buffers[i].length

  var concatenated = new Buffer(size)
  for (var cursor = 0, j = 0; j < buffers.length; cursor += buffers[j].length, j++) {
    buffers[j].copy(concatenated, cursor)
  }

  return concatenated
}

describe('Compressor', function() {
  describe('static function integer(I, N)', function() {
    it('should return an array of buffers that represent the N-prefix coded I value', function() {
      for (var i = 0; i < test_integers.length; i++) {
        var test = test_integers[i]
        expect(concat(Compressor.integer(test.I, test.N))).to.deep.equal(test.buffer)
      }
    })
  })
  describe('static function string(str)', function() {
    it('should return an array of buffers that represent the encoded form of the string str', function() {
      for (var i = 0; i < test_strings.length; i++) {
        var test = test_strings[i]
        expect(concat(Compressor.string(test.string))).to.deep.equal(test.buffer)
      }
    })
  })
  describe('static function header({ name, value, indexing, substitution })', function() {
    it('should return an array of buffers that represent the encoded form of the header', function() {
      for (var i = 0; i < test_headers.length; i++) {
        var test = test_headers[i]
        expect(concat(Compressor.header(test.header))).to.deep.equal(test.buffer)
      }
    })
  })
})

describe('Decompressor', function() {
  describe('static function integer(buffer, N)', function() {
    it('should return the parsed N-prefix coded number and increase the cursor property of buffer', function() {
      for (var i = 0; i < test_integers.length; i++) {
        var test = test_integers[i]
        test.buffer.cursor = 0
        expect(Decompressor.integer(test.buffer, test.N)).to.equal(test.I)
        expect(test.buffer.cursor).to.equal(test.buffer.length)
      }
    })
  })
  describe('static function string(buffer)', function() {
    it('should return the parsed string and increase the cursor property of buffer', function() {
      for (var i = 0; i < test_strings.length; i++) {
        var test = test_strings[i]
        test.buffer.cursor = 0
        expect(Decompressor.string(test.buffer)).to.equal(test.string)
        expect(test.buffer.cursor).to.equal(test.buffer.length)
      }
    })
  })
  describe.only('static function header(buffer)', function() {
    it('should return the parsed header and increase the cursor property of buffer', function() {
      for (var i = 0; i < test_headers.length; i++) {
        var test = test_headers[i]
        test.buffer.cursor = 0
        expect(Decompressor.header(test.buffer)).to.deep.equal(test.header)
        expect(test.buffer.cursor).to.equal(test.buffer.length)
      }
    })
  })
})
