var expect = require('chai').expect;

var Stream = require('../lib/stream').Stream;

function callNTimes(limit, done) {
  var i = 0;
  return function() {
    i += 1;
    if (i === limit) {
      done();
    }
  }
}

// Execute a list of commands and assertions
var recorded_events = ['state', 'error', 'window_update', 'headers', 'promise']
function execute_sequence(stream, sequence, done) {
  if (!done) {
    done = sequence;
    sequence = stream;
    stream = new Stream();
  }

  var outgoing_frames = [];
  stream.upstream.on('sending', outgoing_frames.push.bind(outgoing_frames));

  var emit = stream.emit, events = [];
  stream.emit = function(name, data) {
    if (recorded_events.indexOf(name) !== -1) {
      events.push({ name: name, data: data });
    }
    return emit.apply(this, arguments);
  };

  var commands = [], checks = [];
  sequence.forEach(function(step) {
    if ('method' in step || 'incoming' in step || 'wait' in step || 'set_state' in step) {
      commands.push(step);
    } else {
      checks.push(step);
    }
  });

  function execute(callback) {
    var command = commands.shift();
    if (command) {
      if ('method' in command) {
        stream[command.method.name].apply(stream, command.method.arguments);
        execute(callback);
      } else if ('incoming' in command) {
        stream.upstream.write(command.incoming);
        execute(callback);
      } else if ('set_state' in command) {
        stream.state = command.set_state;
        execute(callback);
      } else if ('wait' in command) {
        setTimeout(execute.bind(null, callback), command.wait);
      } else {
        throw new Error('Invalid command', command);
      }
    } else {
      setTimeout(callback, 5);
    }
  }

  function check() {
    checks.forEach(function(check) {
      if ('outgoing' in check) {
        expect(outgoing_frames.shift()).to.deep.equal(check.outgoing);
      } else if ('event' in check) {
        expect(events.shift()).to.deep.equal(check.event);
      } else {
        throw new Error('Invalid check', check);
      }
    });
    done();
  }

  setImmediate(execute.bind(null, check));
}

var invalid_frames = {
  IDLE: [
    { type: 'DATA', flags: {}, data: new Buffer(5) },
    { type: 'PRIORITY', flags: {}, priority: 1 },
    { type: 'WINDOW_UPDATE', flags: {}, settings: {} },
    { type: 'PUSH_PROMISE', flags: {}, headers: {} }
  ],
  RESERVED_LOCAL: [
    { type: 'DATA', flags: {}, data: new Buffer(5) },
    { type: 'HEADERS', flags: {}, headers: {}, priority: undefined },
    { type: 'PRIORITY', flags: {}, priority: 1 },
    { type: 'PUSH_PROMISE', flags: {}, headers: {} },
    { type: 'WINDOW_UPDATE', flags: {}, settings: {} }
  ],
  RESERVED_REMOTE: [
    { type: 'DATA', flags: {}, data: new Buffer(5) },
    { type: 'PRIORITY', flags: {}, priority: 1 },
    { type: 'PUSH_PROMISE', flags: {}, headers: {} },
    { type: 'WINDOW_UPDATE', flags: {}, settings: {} }
  ],
  OPEN: [
  ],
  HALF_CLOSED_LOCAL: [
  ],
  HALF_CLOSED_REMOTE: [
    { type: 'DATA', flags: {}, data: new Buffer(5) },
    { type: 'HEADERS', flags: {}, headers: {}, priority: undefined },
    { type: 'PRIORITY', flags: {}, priority: 1 },
    { type: 'PUSH_PROMISE', flags: {}, headers: {} },
    { type: 'WINDOW_UPDATE', flags: {}, settings: {} }
  ],
  CLOSED: [ // TODO
  ]
};

describe('stream.js', function() {
  describe('Stream class', function() {
    describe('._transition(sending, frame) method', function() {
      Object.keys(invalid_frames).forEach(function(state) {
        it('should emit error, and answer RST_STREAM for invalid incoming frames in ' + state + ' state', function(done) {
          var left = invalid_frames[state].length + 1;
          function one_done() {
            left -= 1;
            if (!left) {
              done();
            }
          }
          one_done();

          invalid_frames[state].forEach(function(invalid_frame) {
            var stream = new Stream();
            var error_emitted = false;
            stream.on('error', function() {
              error_emitted = true;
            });
            execute_sequence(stream, [
              { set_state: state },
              { incoming : invalid_frame },
              { wait     : 10 },
              { outgoing : { type: 'RST_STREAM', flags: {}, error: 'PROTOCOL_ERROR' } }
            ], function sequence_ready() {
              expect(error_emitted).to.equal(true);
              one_done();
            });
          });
        });
      });
    });
  });
  describe('test scenario', function() {
    describe('sending request', function() {
      it('should trigger the appropriate state transitions and outgoing frames', function(done) {
        execute_sequence([
          { method  : { name: 'headers', arguments: [{ ':path': '/' }] } },
          { outgoing: { type: 'HEADERS', flags: { }, headers: { ':path': '/' }, priority: undefined } },
          { event   : { name: 'state', data: 'OPEN' } },

          { wait    : 5 },
          { method  : { name: 'end', arguments: [] } },
          { event   : { name: 'state', data: 'HALF_CLOSED_LOCAL' } },
          { outgoing: { type: 'DATA', flags: { END_STREAM: true  }, data: new Buffer(0) } },

          { wait    : 10 },
          { incoming: { type: 'HEADERS', flags: { }, headers: { ':status': 200 } } },
          { incoming: { type: 'DATA'   , flags: { END_STREAM: true  }, data: new Buffer(5) } },
          { event   : { name: 'headers', data: { ':status': 200 } } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);
      });
    });
    describe('answering request', function() {
      it('should trigger the appropriate state transitions and outgoing frames', function(done) {
        var payload = new Buffer(5);
        execute_sequence([
          { incoming: { type: 'HEADERS', flags: { }, headers: { ':path': '/' } } },
          { event   : { name: 'headers', data: { ':path': '/' } } },
          { event   : { name: 'state', data: 'OPEN' } },

          { wait    : 5 },
          { incoming: { type: 'DATA', flags: { }, data: new Buffer(5) } },
          { incoming: { type: 'DATA', flags: { END_STREAM: true  }, data: new Buffer(10) } },
          { event   : { name: 'state', data: 'HALF_CLOSED_REMOTE' } },

          { wait    : 5 },
          { method  : { name: 'headers', arguments: [{ ':status': 200 }] } },
          { outgoing: { type: 'HEADERS', flags: { }, headers: { ':status': 200 }, priority: undefined } },

          { wait    : 5 },
          { method  : { name: 'end', arguments: [payload] } },
          { outgoing: { type: 'DATA', flags: { END_STREAM: true  }, data: payload } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);
      });
    });
    describe('sending push stream', function() {
      it('should trigger the appropriate state transitions and outgoing frames', function(done) {
        var payload = new Buffer(5);
        var original_stream = new Stream();
        var promised_stream = new Stream();

        done = callNTimes(2, done);

        execute_sequence(original_stream, [
          // receiving request
          { incoming: { type: 'HEADERS', flags: { END_STREAM: true }, headers: { ':path': '/' } } },
          { event   : { name: 'headers', data: { ':path': '/' } } },
          { event   : { name: 'state', data: 'OPEN' } },
          { event   : { name: 'state', data: 'HALF_CLOSED_REMOTE' } },

          // sending response headers
          { wait    : 5 },
          { method  : { name: 'headers', arguments: [{ ':status': '200' }] } },
          { outgoing: { type: 'HEADERS', flags: {  }, headers: { ':status': '200' }, priority: undefined } },

          // sending push promise
          { method  : { name: 'promise', arguments: [promised_stream, { ':path': '/' }] } },
          { outgoing: { type: 'PUSH_PROMISE', flags: { }, headers: { ':path': '/' }, promised_stream: promised_stream } },

          // sending response data
          { method  : { name: 'end', arguments: [payload] } },
          { outgoing: { type: 'DATA', flags: { END_STREAM: true  }, data: payload } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);

        execute_sequence(promised_stream, [
          // initial state of the promised stream
          { event   : { name: 'state', data: 'RESERVED_LOCAL' } },

          // push headers
          { wait    : 5 },
          { method  : { name: 'headers', arguments: [{ ':status': '200' }] } },
          { outgoing: { type: 'HEADERS', flags: { }, headers: { ':status': '200' }, priority: undefined } },
          { event   : { name: 'state', data: 'HALF_CLOSED_REMOTE' } },

          // push data
          { method  : { name: 'end', arguments: [payload] } },
          { outgoing: { type: 'DATA', flags: { END_STREAM: true  }, data: payload } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);
      });
    });
    describe('receiving push stream', function() {
      it('should trigger the appropriate state transitions and outgoing frames', function(done) {
        var payload = new Buffer(5);
        var original_stream = new Stream();
        var promised_stream = new Stream();

        done = callNTimes(2, done);

        execute_sequence(original_stream, [
          // sending request headers
          { method  : { name: 'headers', arguments: [{ ':path': '/' }] } },
          { method  : { name: 'end', arguments: [] } },
          { outgoing: { type: 'HEADERS', flags: { END_STREAM: true  }, headers: { ':path': '/' }, priority: undefined } },
          { event   : { name: 'state', data: 'OPEN' } },
          { event   : { name: 'state', data: 'HALF_CLOSED_LOCAL' } },

          // receiving response headers
          { wait    : 10 },
          { incoming: { type: 'HEADERS', flags: { }, headers: { ':status': 200 } } },
          { event   : { name: 'headers', data: { ':status': 200 } } },

          // receiving push promise
          { incoming: { type: 'PUSH_PROMISE', flags: { }, headers: { ':path': '/2.html' }, promised_stream: promised_stream } },
          { event   : { name: 'promise', data: { ':path': '/2.html' } } },

          // receiving response data
          { incoming: { type: 'DATA'   , flags: { END_STREAM: true  }, data: payload } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);

        execute_sequence(promised_stream, [
          // initial state of the promised stream
          { event   : { name: 'state', data: 'RESERVED_REMOTE' } },

          // push headers
          { wait    : 10 },
          { incoming: { type: 'HEADERS', flags: { END_STREAM: false }, headers: { ':status': 200 } } },
          { event   : { name: 'headers', data: { ':status': 200 } } },
          { event   : { name: 'state', data: 'HALF_CLOSED_LOCAL' } },

          // push data
          { incoming: { type: 'DATA', flags: { END_STREAM: true  }, data: payload } },
          { event   : { name: 'state', data: 'CLOSED' } }
        ], done);
      });
    });
  });
});
