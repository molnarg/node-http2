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
    length: 24,

    settings: {
      SETTINGS_MAX_CONCURRENT_STREAMS: 0x01234567,
      SETTINGS_INITIAL_WINDOW_SIZE:    0x89ABCDEF,
      SETTINGS_FLOW_CONTROL_OPTIONS:   true
    }
  },
  buffer: new Buffer('0018' + '04' + '00' + '0000000A' +   '00' + '000004' + '01234567' +
                                                           '00' + '000007' + '89ABCDEF' +
                                                           '00' + '00000A' + '00000001', 'hex')
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

// Concatenate two buffer into a new buffer
function concat(buffer1, buffer2) {
  var concatenated = new Buffer(buffer1.length + buffer2.length)
  buffer1.copy(concatenated)
  buffer2.copy(concatenated, buffer1.length)
  return concatenated
}

// Concatenate an array of buffers and then cut them into random size buffers
function shuffle_buffers(buffers) {
  var concatenated = new Buffer(0)
  for (var i = 0; i < buffers.length; i++) concatenated = concat(concatenated, buffers[i])

  var output = []
  var written = 0
  while (written < concatenated.length) {
    var chunk_size = Math.min(concatenated.length - written, Math.ceil(Math.random()*20))
    output.push(concatenated.slice(written, written + chunk_size))
    written += chunk_size
  }

  return output
}

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

    describe('transform stream', function() {
      it('should transform frame objects to appropriate buffers', function() {
        var stream = new Serializer()
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i]
          stream.write(test.frame)
          var chunk, buffer = new Buffer(0)
          while (chunk = stream.read()) buffer = concat(buffer, chunk)
          expect(buffer).to.be.deep.equal(test.buffer)
        }
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

    describe('transform stream', function() {
      it('should transform buffers to appropriate frame object', function() {
        var stream = new Deserializer()

        shuffle_buffers(test_frames.map(function(test) { return test.buffer }))
          .forEach(stream.write.bind(stream))

        for (var j = 0; j < test_frames.length; j++) {
          var parsed_frame = stream.read()
          parsed_frame.length = test_frames[j].frame.length
          expect(parsed_frame).to.be.deep.equal(test_frames[j].frame)
        }
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
