var expect = require('chai').expect

var compressor = require('../lib/compressor')
  , Compressor = compressor.Compressor
  , Decompressor = compressor.Decompressor

var test_integers = [{
  N: 5,
  I: 10,
  bytes: [10]
}, {
  N: 5,
  I: 1337,
  bytes: [31, 128 + 26, 10]
}]

describe('Compressor', function() {
  describe('static function integer(I, N)', function() {
    it('should return an array of bytes that represent the N-prefix coded I value', function() {
      for (var i = 0; i < test_integers.length; i++) {
        var test = test_integers[i]
        expect(Compressor.integer(test.I, test.N)).to.deep.equal(test.bytes)
      }
    })
  })
})

describe('Decompressor', function() {
  describe('static function integer(bytes, N)', function() {
    it('should return { value: the parsed N-prefix coded number, length: number of bytes processed }', function() {
      for (var i = 0; i < test_integers.length; i++) {
        var test = test_integers[i]
        var result = Decompressor.integer(test.bytes, test.N)
        expect(result.value).to.equal(test.I)
        expect(result.length).to.equal(test.bytes.length)
      }
    })
  })
})
