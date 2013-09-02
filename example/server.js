var fs = require('fs');
var path = require('path');
var http2 = require('..');

if (process.env.HTTP2_LOG) {
  var log = require('bunyan').createLogger({
    name: 'server',
    stream: process.stderr,
    level: process.env.HTTP2_LOG,
    serializers: http2.serializers
  });
}

var options = {
  key: fs.readFileSync(path.join(__dirname, '/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '/localhost.crt')),
  log: log
};

var server = http2.createServer(options, function(request, response) {
  var filename = path.join(__dirname, request.url);

  if ((filename.indexOf(__dirname) === 0) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {
    var filestream = fs.createReadStream(filename);
    response.writeHead('200');

    // If they download the certificate, push the private key too, they might need it.
    if (response.push && request.url === '/localhost.crt') {
      var push = response.push('/localhost.key');
      push.writeHead(200);
      fs.createReadStream(path.join(__dirname, '/localhost.key')).pipe(push);
    }

    filestream.pipe(response);

  } else {
    response.writeHead('404');
    response.end();
  }
});

server.listen(process.env.HTTP2_PORT || 8080);
