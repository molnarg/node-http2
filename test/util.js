if (process.env.HTTP2_LOG) {
  exports.log = require('bunyan').createLogger({
    name: 'test',
    stream: process.stderr,
    level: process.env.HTTP2_LOG,
    serializers: require('../lib/http').serializers
  });
} else {
  function noop() {}
  exports.log = {
    fatal: noop,
    error: noop,
    warn : noop,
    info : noop,
    debug: noop,
    trace: noop,

    child: function() { return this; }
  };
}

exports.callNTimes = function callNTimes(limit, done) {
  if (limit === 0) {
    done();
  } else {
    var i = 0;
    return function() {
      i += 1;
      if (i === limit) {
        done();
      }
    };
  }
};

// Concatenate an array of buffers into a new buffer
exports.concat = function concat(buffers) {
  var size = 0;
  for (var i = 0; i < buffers.length; i++) {
    size += buffers[i].length;
  }

  var concatenated = new Buffer(size);
  for (var cursor = 0, j = 0; j < buffers.length; cursor += buffers[j].length, j++) {
    buffers[j].copy(concatenated, cursor);
  }

  return concatenated;
};

