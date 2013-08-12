var logging = exports;

if (process.env.HTTP2_LOG) {
  var bunyan = require('bunyan');

  logging.root = bunyan.createLogger({
    name: 'http2',
    level: process.env.HTTP2_LOG,
    serializers: bunyan.stdSerializers
  });

  logging.serializers = logging.root.serializers;

} else {
  function noop() {}
  logging.root = {
    fatal: noop,
    error: noop,
    warn : noop,
    info : noop,
    debug: noop,
    trace: noop,

    child: function() { return this; }
  };

  logging.serializers = {};
}
