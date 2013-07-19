var fs = require('fs');
var net = require('net');
var path = require('path');
var http2 = require('../lib/index');
var Endpoint = http2.endpoint.Endpoint;

var settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 1,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

var server = net.createServer(function(socket) {
  console.error('Incoming connection.');

  var server_endpoint = new Endpoint('SERVER', settings);
  server_endpoint.pipe(socket).pipe(server_endpoint);

  server_endpoint._connection.on('incoming_stream', function(stream) {
    console.error('Incoming stream.');

    stream.on('headers', function(headers) {
      var filename = path.join(__dirname, headers[':path']);
      console.error('Incoming request:', headers[':path'], '(' + filename + ')');

      if (fs.existsSync(filename)) {
        console.error('Reading file from disk.');
        stream.open({
          ':status': '200'
        });
        var filestream = fs.createReadStream(filename);
        filestream.pipe(stream);

      } else {
        console.error('File not found.');
        stream.open({
          ':status': '404'
        });
        stream.end();
      }
    });
  });
});

server.listen(8080);
console.error('Listening on localhost:8080, serving up files from', __dirname);
