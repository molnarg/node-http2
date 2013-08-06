var fs = require('fs');
var path = require('path');
var http2 = require('../lib/index');

var server = http2.http.createServer({
  key: fs.readFileSync(path.join(__dirname, './localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '/localhost.crt'))
}, function(request, response) {
  var filename = path.join(__dirname, request.url);
  console.error('Incoming request:', request.url, '(' + filename + ')');

  if (fs.existsSync(filename) && fs.statSync(filename).isFile()) {
    console.error('Reading file from disk.');
    var filestream = fs.createReadStream(filename);
    response.writeHead('200');
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
