var parse_url = require('url').parse;
var path = require('path');
var http2 = require('..');

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
