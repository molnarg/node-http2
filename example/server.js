var fs = require('fs');
var path = require('path');
var http2 = require('..');

var serverjs = fs.readFileSync(path.join(__dirname, './server.js'));

var options = {
  key: fs.readFileSync(path.join(__dirname, '/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '/localhost.crt')),
  log: require('../test/util').createLogger('server')
};

var server = http2.createServer(options, function(request, response) {
  var filename = path.join(__dirname, request.url);

  // Serving server.js from cache. Useful for microbenchmarks.
  if (request.url === '/server.js') {
    response.end(serverjs);
  }

  // Reading file from disk if it exists and is safe.
  else if ((filename.indexOf(__dirname) === 0) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {
    response.writeHead('200');

    // If they download the certificate, push the private key too, they might need it.
    if (response.push && request.url === '/localhost.crt') {
      var push = response.push('/localhost.key');
      push.writeHead(200);
      fs.createReadStream(path.join(__dirname, '/localhost.key')).pipe(push);
    }

    fs.createReadStream(filename).pipe(response);
  }

  // Otherwise responding with 404.
  else {
    response.writeHead('404');
    response.end();
  }
});

server.listen(process.env.HTTP2_PORT || 8080);
