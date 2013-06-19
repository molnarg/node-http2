var expect = require('chai').expect

var framer = require('../lib/framer')
  , Serializer = framer.Serializer
  , Deserializer = framer.Deserializer

var frame_types = {
  'DATA': ['data'],
  'HEADERS+PRIORITY': ['priority', 'data'],
  'PRIORITY': ['priority'],
  'RST_STREAM': ['error'],
  'SETTINGS': ['settings'],
  'PUSH_PROMISE': ['promised_stream', 'data'],
  'PING': ['data'],
  'GOAWAY': ['last_stream', 'error'],
  'HEADERS': ['data'],
  'WINDOW_UPDATE': ['window_size']
}

var test_frames = [{
  frame: {
    type: 'DATA',
    flags: { 'FINAL': false },
    stream: 10,
    length: 4,

    data: new Buffer('12345678', 'hex')
  },
  // length + type + flags + stream +   content
  buffer: new Buffer('0004' + '00' + '00' + '0000000A' +   '12345678', 'hex')
}, {
  frame: {
    type: 'HEADERS+PRIORITY',
    flags: { 'FINAL': false, 'CONTINUES': false },
    stream: 15,
    length: 8,

    priority: 3,
    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0008' + '01' + '00' + '0000000F' +   '00000003' + '12345678', 'hex')
}, {
  frame: {
    type: 'PRIORITY',
    flags: { 'FINAL': false },
    stream: 10,
    length: 4,

    priority: 3
  },
  buffer: new Buffer('0004' + '02' + '00' + '0000000A' +   '00000003', 'hex')
}, {
  frame: {
    type: 'RST_STREAM',
    flags: { 'FINAL': false },
    stream: 10,
    length: 4,

    error: 0x101010
  },
  buffer: new Buffer('0004' + '03' + '00' + '0000000A' +   '00101010', 'hex')
}, {
  frame: {
    type: 'SETTINGS',
    flags: { 'FINAL': false, 'CLEAR_PERSISTED': false },
    stream: 10,
    length: 0
  },
  buffer: new Buffer('0000' + '04' + '00' + '0000000A' +   '', 'hex')
}, {
  frame: {
    type: 'PUSH_PROMISE',
    flags: { 'FINAL': false, 'CONTINUES': false },
    stream: 15,
    length: 8,

    promised_stream: 3,
    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0008' + '05' + '00' + '0000000F' +   '00000003' + '12345678', 'hex')
}, {
  frame: {
    type: 'PING',
    flags: { 'FINAL': false, 'PONG': false },
    stream: 15,
    length: 8,

    data: new Buffer('1234567887654321', 'hex')
  },
  buffer: new Buffer('0008' + '06' + '00' + '0000000F' +   '1234567887654321', 'hex')
}, {
  frame: {
    type: 'GOAWAY',
    flags: { 'FINAL': false },
    stream: 10,
    length: 8,

    last_stream: 0x12345678,
    error: 0x87654321
  },
  buffer: new Buffer('0008' + '07' + '00' + '0000000A' +   '12345678' + '87654321', 'hex')
}, {
  frame: {
    type: 'HEADERS',
    flags: { 'FINAL': false, 'CONTINUES': false },
    stream: 10,
    length: 4,

    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0004' + '08' + '00' + '0000000A' +   '12345678', 'hex')
}, {
  frame: {
    type: 'WINDOW_UPDATE',
    flags: { 'FINAL': false, 'END_FLOW_CONTROL': false },
    stream: 10,
    length: 4,

    window_size: 0x12345678
  },
  buffer: new Buffer('0004' + '09' + '00' + '0000000A' +   '12345678', 'hex')
}]

describe('Framer', function() {
  describe('Serializer', function() {
    describe('static method .commonHeader({ length, type, flags, stream })', function() {
      it('should return the appropriate 8 byte header buffer', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i]
          expect(Serializer.commonHeader(test.frame)).to.deep.equal(test.buffer.slice(0,8))
        }
      })
    })

    Object.keys(frame_types).forEach(function(type) {
      var tests = test_frames.filter(function(test) { return test.frame.type === type })
      var frame_shape = '{ ' + frame_types[type].join(', ') + ' }'
      describe('static method [\'' + type + '\'](' + frame_shape + ')', function() {
        it('should return a ' + type + ' type payload buffer', function() {
          for (var i = 0; i < tests.length; i++) {
            var test = tests[i]
            expect(Serializer[type](test.frame)).to.deep.equal(test.buffer.slice(8))
          }
        })
      })
    })
  })

  describe('Deserializer', function() {
    describe('static method .commonHeader(header_buffer)', function() {
      it('should return the appropriate header object', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i]
          expect(Deserializer.commonHeader(test.buffer.slice(0,8))).to.deep.equal({
            length: test.frame.length,
            type:   test.frame.type,
            flags:  test.frame.flags,
            stream: test.frame.stream
          })
        }
      })
    })

    Object.keys(frame_types).forEach(function(type) {
      var tests = test_frames.filter(function(test) { return test.frame.type === type })
      var frame_shape = '{ ' + frame_types[type].join(', ') + ' }'
      describe('static method [\'' + type + '\'](payload_buffer)', function() {
        it('should return the parsed frame object with these properties: ' + frame_shape, function() {
          for (var i = 0; i < tests.length; i++) {
            var test = tests[i]
            var parsed = Deserializer[type](test.buffer.slice(8))
            parsed.length = test.frame.length
            parsed.type =   test.frame.type
            parsed.flags =  test.frame.flags
            parsed.stream = test.frame.stream
            expect(parsed).to.deep.equal(test.frame)
          }
        })
      })
    })
  })

  describe('invariant', function() {
    describe('header === Deserializer.commonHeader(Serializer.commonHeader(header))', function() {
      it('should always be true for well formed header objects', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var frame = test_frames[i].frame
          var header = {
            length: frame.length,
            type:   frame.type,
            flags:  frame.flags,
            stream: frame.stream
          }
          expect(Deserializer.commonHeader(Serializer.commonHeader(header))).to.deep.equal(header)
        }
      })
    })

    describe('buffer === Serializer.commonHeader(Deserializer.commonHeader(buffer))', function() {
      it('should always be true for well formed header buffers', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var buffer = test_frames[i].buffer.slice(0,8)
          expect(Serializer.commonHeader(Deserializer.commonHeader(buffer))).to.deep.equal(buffer)
        }
      })
    })
  })
})
