var fs = require('fs');
var path = require('path');
var http2 = require('..');

var options = {
  key: fs.readFileSync(path.join(__dirname, '/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '/localhost.crt'))
};

var server = http2.createServer(options, function(request, response) {
  var filename = path.join(__dirname, request.url);
  console.error('Incoming request:', request.url, '(' + filename + ')');

  if ((filename.indexOf(__dirname) === 0) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {
    console.error('Reading file from disk.');
    var filestream = fs.createReadStream(filename);
    response.writeHead('200');

    // If they download the certificate, push the private key too, they might need it.
    if (request.url === '/localhost.crt') {
      var connection = server._endpoint._connection;
      var stream = response._stream;
      var push = connection.createStream();
      stream.promise(push, {
        ':scheme': 'https',
        ':method': 'get',
        ':host': 'localhost',
        ':path': '/localhost.key'
      });
      push.headers({ ':status': 200 });
      fs.createReadStream(path.join(__dirname, '/localhost.key')).pipe(push);
    }

    filestream.pipe(response);

  } else {
    console.error('File not found.');
    response.writeHead('404');
    response.end();
  }
});

var port = process.env.HTTP2_PORT || 8080;
server.listen(port);
console.error('Listening on localhost:' + port + ', serving up files from', __dirname);
