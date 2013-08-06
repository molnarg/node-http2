var parse_url = require('url').parse;
var path = require('path');
var http2 = require('..');

var settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 1,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

var url = parse_url(process.argv.pop());

var request = http2.request({
  method: 'get',
  host: url.hostname,
  port: url.port,
  url: url.path,
  rejectUnauthorized: false
});
request.end();

request.on('response', function(response) {
  response.pipe(process.stderr);
  response.on('end', process.exit);
});
