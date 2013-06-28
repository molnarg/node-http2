var expect = require('chai').expect;

var framer = require('../lib/framer')
  , Serializer = framer.Serializer
  , Deserializer = framer.Deserializer;

var frame_types = {
  DATA:          ['data'],
  HEADERS:       ['priority', 'data'],
  PRIORITY:      ['priority'],
  RST_STREAM:    ['error'],
  SETTINGS:      ['settings'],
  PUSH_PROMISE:  ['promised_stream', 'data'],
  PING:          ['data'],
  GOAWAY:        ['last_stream', 'error'],
  WINDOW_UPDATE: ['window_size']
};

var test_frames = [{
  frame: {
    type: 'DATA',
    flags: { END_STREAM: false, RESERVED: false },
    stream: 10,
    length: 4,

    data: new Buffer('12345678', 'hex')
  },
  // length + type + flags + stream +   content
  buffer: new Buffer('0004' + '00' + '00' + '0000000A' +   '12345678', 'hex')

}, {
  frame: {
    type: 'HEADERS',
    flags: { END_STREAM: false, RESERVED: false, END_HEADERS: false, PRIORITY: false },
    stream: 15,
    length: 4,

    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0004' + '01' + '00' + '0000000F' +   '12345678', 'hex')

}, {
  frame: {
    type: 'HEADERS',
    flags: { END_STREAM: false, RESERVED: false, END_HEADERS: false, PRIORITY: true },
    stream: 15,
    length: 8,

    priority: 3,
    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0008' + '01' + '08' + '0000000F' +   '00000003' + '12345678', 'hex')

}, {
  frame: {
    type: 'PRIORITY',
    flags: { },
    stream: 10,
    length: 4,

    priority: 3
  },
  buffer: new Buffer('0004' + '02' + '00' + '0000000A' +   '00000003', 'hex')

}, {
  frame: {
    type: 'RST_STREAM',
    flags: { },
    stream: 10,
    length: 4,

    error: 'INTERNAL_ERROR'
  },
  buffer: new Buffer('0004' + '03' + '00' + '0000000A' +   '00000002', 'hex')

}, {
  frame: {
    type: 'SETTINGS',
    flags: { },
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
    flags: { END_PUSH_PROMISE: false },
    stream: 15,
    length: 8,

    promised_stream: 3,
    data: new Buffer('12345678', 'hex')
  },
  buffer: new Buffer('0008' + '05' + '00' + '0000000F' +   '00000003' + '12345678', 'hex')

}, {
  frame: {
    type: 'PING',
    flags: { PONG: false },
    stream: 15,
    length: 8,

    data: new Buffer('1234567887654321', 'hex')
  },
  buffer: new Buffer('0008' + '06' + '00' + '0000000F' +   '1234567887654321', 'hex')

}, {
  frame: {
    type: 'GOAWAY',
    flags: { },
    stream: 10,
    length: 8,

    last_stream: 0x12345678,
    error: 'PROTOCOL_ERROR'
  },
  buffer: new Buffer('0008' + '07' + '00' + '0000000A' +   '12345678' + '00000001', 'hex')

}, {
  frame: {
    type: 'WINDOW_UPDATE',
    flags: { END_FLOW_CONTROL: false },
    stream: 10,
    length: 4,

    window_size: 0x12345678
  },
  buffer: new Buffer('0004' + '09' + '00' + '0000000A' +   '12345678', 'hex')
}];

// Concatenate two buffer into a new buffer
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

// Concatenate an array of buffers and then cut them into random size buffers
function shuffle_buffers(buffers) {
  var concatenated = concat(buffers), output = [], written = 0;

  while (written < concatenated.length) {
    var chunk_size = Math.min(concatenated.length - written, Math.ceil(Math.random()*20));
    output.push(concatenated.slice(written, written + chunk_size));
    written += chunk_size;
  }

  return output;
}

describe('Framer', function() {
  describe('Serializer', function() {
    describe('static method .commonHeader({ type, flags, stream }, buffer_array)', function() {
      it('should add the appropriate 8 byte header buffer in front of the others', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i]
            , buffers = [test.buffer.slice(8)]
            , header_buffer = test.buffer.slice(0,8);
          Serializer.commonHeader(test.frame, buffers);
          expect(buffers[0]).to.deep.equal(header_buffer);
        }
      });
    });

    Object.keys(frame_types).forEach(function(type) {
      var tests = test_frames.filter(function(test) { return test.frame.type === type });
      var frame_shape = '{ ' + frame_types[type].join(', ') + ' }';
      describe('static method .' + type + '(' + frame_shape + ', buffer_array)', function() {
        it('should push buffers to the array that make up a ' + type + ' type payload', function() {
          for (var i = 0; i < tests.length; i++) {
            var test = tests[i]
              , buffers = [];
            Serializer[type](test.frame, buffers);
            expect(concat(buffers)).to.deep.equal(test.buffer.slice(8));
          }
        });
      });
    });

    describe('transform stream', function() {
      it('should transform frame objects to appropriate buffers', function() {
        var stream = new Serializer();
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i];
          stream.write(test.frame);
          var chunk, buffer = new Buffer(0);
          while (chunk = stream.read()) {
            buffer = concat([buffer, chunk]);
          }
          expect(buffer).to.be.deep.equal(test.buffer);
        }
      });
    });
  });

  describe('Deserializer', function() {
    describe('static method .commonHeader(header_buffer, frame)', function() {
      it('should augment the frame object with these properties: { length, type, flags, stream })', function() {
        for (var i = 0; i < test_frames.length; i++) {
          var test = test_frames[i], frame = {};
          Deserializer.commonHeader(test.buffer.slice(0,8), frame);
          expect(frame).to.deep.equal({
            length: test.frame.length,
            type:   test.frame.type,
            flags:  test.frame.flags,
            stream: test.frame.stream
          });
        }
      });
    });

    Object.keys(frame_types).forEach(function(type) {
      var tests = test_frames.filter(function(test) { return test.frame.type === type });
      var frame_shape = '{ ' + frame_types[type].join(', ') + ' }';
      describe('static method .' + type + '(payload_buffer, frame)', function() {
        it('should augment the frame object with these properties: ' + frame_shape, function() {
          for (var i = 0; i < tests.length; i++) {
            var test = tests[i];
            var frame = {
              length: test.frame.length,
              type:   test.frame.type,
              flags:  test.frame.flags,
              stream: test.frame.stream
            };
            Deserializer[type](test.buffer.slice(8), frame);
            expect(frame).to.deep.equal(test.frame);
          }
        });
      });
    });

    describe('transform stream', function() {
      it('should transform buffers to appropriate frame object', function() {
        var stream = new Deserializer();

        shuffle_buffers(test_frames.map(function(test) { return test.buffer }))
          .forEach(stream.write.bind(stream));

        for (var j = 0; j < test_frames.length; j++) {
          var parsed_frame = stream.read();
          parsed_frame.length = test_frames[j].frame.length;
          expect(parsed_frame).to.be.deep.equal(test_frames[j].frame);
        }
      });
    });
  });
});
