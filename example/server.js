var fs = require('fs');
var net = require('net');
var path = require('path');
var http2 = require('../lib/index');
var Endpoint = http2.endpoint.Endpoint;

var settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 1,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

var server = http2.http.createServer({
  plain: true,
  settings: settings
}, function(request, response) {
  var filename = path.join(__dirname, request.url);
  console.error('Incoming request:', request.url, '(' + filename + ')');

  if (fs.existsSync(filename)) {
    console.error('Reading file from disk.');
    response.writeHead('200');
    var filestream = fs.createReadStream(filename);
    filestream.pipe(response);

  } else {
    console.error('File not found.');
    response.writeHead('404');
    response.end();
  }
});

var port = 8080;
if ('HTTP2_PORT' in process.env) {
    port = parseInt(process.env.HTTP2_PORT);
}
server.listen(port);
console.error('Listening on localhost:' + port + ', serving up files from', __dirname);
