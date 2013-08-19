var fs = require('fs');
var path = require('path');
var http2 = require('..');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var request = http2.get(process.argv.pop());

var push_count = 0;
var finished = 0;
function finish() {
  finished += 1;
  if (finished === (1 + push_count)) {
    process.exit();
  }
}

request.on('response', function(response) {
  response.on('push', function(pushRequest) {
    var filename = path.join(__dirname, '/push-' + (push_count));
    push_count += 1;
    console.log('Receiving pushed resource: ' + pushRequest.url + ' -> ' + filename);
    pushRequest.on('response', function(pushResponse) {
      pushResponse.pipe(fs.createWriteStream(filename)).on('finish', finish);
    });
  });

  response.pipe(process.stderr);
  response.on('end', finish);
});
