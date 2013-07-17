var utils = require('./utils');
var logging = exports;

if (process.env.HTTP2_LOG) {
  var bunyan = require('bunyan');

  logging.serializers = utils.shallow_copy(bunyan.stdSerializers);

  logging.root = bunyan.createLogger({
    name: 'http2',
    level: process.env.HTTP2_LOG,
    serializers: logging.serializers
  });

} else {
  logging.serializers = {};

  logging.root = {
    fatal: utils.noop,
    error: utils.noop,
    warn : utils.noop,
    info : utils.noop,
    debug: utils.noop,
    trace: utils.noop,

    child: function() { return this; }
  };
}
