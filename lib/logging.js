var utils = require('./utils');
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
  logging.root = {
    fatal: utils.noop,
    error: utils.noop,
    warn : utils.noop,
    info : utils.noop,
    debug: utils.noop,
    trace: utils.noop,

    child: function() { return this; }
  };

  logging.serializers = {};
}
