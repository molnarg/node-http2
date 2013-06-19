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

describe('Framer', function() {
  describe('Serializer', function() {
    describe('.prototype.commonHeader({ length, type, flags, stream })', function() {
      it('should return the appropriate 8 byte header buffer')
    })

    for (var type in frame_types) {
      describe('.prototype[\'' + type + '\']({ ' + frame_types[type].join(', ') + ' })', function() {
        it('should return a ' + type + ' type payload buffer')
      })
    }
  })

  describe('Deserializer', function() {
    describe('.prototype.commonHeader(buffer)', function() {
      it('should return the appropriate header object')
    })

    for (var type in frame_types) {
      describe('.prototype[\'' + type + '\'](buffer)', function() {
        it('should return an object with these properties: ' + frame_types[type].join(', '))
      })
    }
  })

  describe('invariants', function() {
    describe('frame === deserializer.commonHeader(serializer.commonHeader(frame))', function() {
      it('should always be true for well formed frame object')
    })

    describe('buffer === serializer.commonHeader(deserializer.commonHeader(buffer))', function() {
      it('should always be true for well formed frame buffers')
    })
  })
})
