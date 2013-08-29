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

http2.globalAgent = new http2.Agent({ log: util.log });

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
/*
    describe('two parallel request', function() {
      it.only('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1234, function() {
          done = util.callNTimes(2, done);
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
          http2.get('https://localhost:1234' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
*/
    describe('server push', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var pushedPath = '/y';
        var pushedMessage = 'Hello world 2';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          var push = response.push('/y');
          push.end(pushedMessage);
          response.end(message);
        });

        server.listen(1235, function() {
          var request = http2.get('https://localhost:1235' + path);
          done = util.callNTimes(4, done);

          request.on('response', function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
            response.on('end', done);
          });

          request.on('push', function(promise) {
            expect(promise.url).to.be.equal(pushedPath);
            promise.on('response', function(pushStream) {
              pushStream.on('readable', function() {
                expect(pushStream.read().toString()).to.equal(pushedMessage);
                done();
              });
              pushStream.on('end', done);
            });
          });
        });
      });
    });
  });
});
