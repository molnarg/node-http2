var fs = require('fs');
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

var push_count = 0;
var finished = 0;
function finish() {
  finished += 1;
  if (finished === (1 + push_count)) {
    process.exit();
  }
}

request.on('response', function(response) {
  response._stream.on('promise', function(pushed, headers) {
    var filename = path.join(__dirname, '/push-' + (push_count));
    push_count += 1;
    console.log('Receiving pushed resource: ' + headers[':path'] + ' -> ' + filename);
    pushed.pipe(fs.createWriteStream(filename)).on('finish', finish);
  });

  response.pipe(process.stderr);
  response.on('end', finish);
});
