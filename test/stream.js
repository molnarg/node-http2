var expect = require('chai').expect;

var Stream = require('../lib/stream').Stream;

var log = process.env.DEBUG ? require('bunyan').createLogger({ name: 'http2', level: 'trace' })
                            : undefined;

// Execute a list of commands and assertions
function execute_sequence(sequence) {
  var stream = new Stream(log);

  var outgoing_frames = [];
  stream.upstream.on('data', outgoing_frames.push.bind(outgoing_frames));

  var emit = stream.emit, events = [];
  stream.emit = function(name, data) {
    events.push({ name: name, data: data });
    return emit.apply(this, arguments);
  };

  sequence.forEach(function(step) {
    if ('state' in step) {
      expect(stream).to.have.property('state', step.state);

    } else if ('outgoing' in step) {
      expect(outgoing_frames.shift()).to.deep.equal(step.outgoing);

    } else if ('event' in step) {
      expect(events.shift()).to.deep.equal(step.event);

    } else if ('method' in step) {
      stream[step.method.name].apply(stream, step.method.arguments);

    } else if ('incoming' in step) {
      stream.upstream.push(step.incoming);

    } else {
      throw new Error('Invalid step');
    }
  });
}

describe('stream.js', function() {
  describe('Stream class', function() {
    it('should go over the appropriate states in the simplest client request scenario', function() {
      execute_sequence([
        { method  : { name: 'open', arguments: [{ ':path': '/' }] } },
        { outgoing: { type: 'HEADERS', flags: { END_STREAM: true  }, headers: { ':path': '/' } } },
        { event   : { name: 'state', data: 'OPEN' } },
        { event   : { name: 'state', data: 'HALF_CLOSED_LOCAL' } },

        { incoming: { type: 'HEADERS', flags: { END_STREAM: false }, headers: { ':status': 200 } } },
        { incoming: { type: 'DATA'   , flags: { END_STREAM: true  }, data: new Buffer(5) } },
        { event   : { name: 'state', data: 'CLOSED' } }
      ]);
    });
    it('should go over the appropriate states in a server push scenario', function() {
      execute_sequence([
        { incoming: { type: 'PUSH_PROMISE', flags: { END_STREAM: false }, headers: { ':path': '/' } } },
        { event   : { name: 'state', data: 'RESERVED_REMOTE' } },

        { incoming: { type: 'HEADERS'     , flags: { END_STREAM: false }, headers: { ':status': 200 } } },
        { event   : { name: 'state', data: 'HALF_CLOSED_LOCAL' } },

        { incoming: { type: 'DATA'        , flags: { END_STREAM: true  }, data: new Buffer(5) } },
        { event   : { name: 'state', data: 'CLOSED' } }
      ]);
    });
  });
});
