var expect = require('chai').expect;
var util = require('./util');
var fs = require('fs');
var path = require('path');

var http2 = require('../lib/http');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: util.log
};

describe('http.js', function() {
  describe('test scenario', function() {
    describe('simple request', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1234, function() {
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
  });
});
