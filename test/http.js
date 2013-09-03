var expect = require('chai').expect;
var util = require('./util');
var fs = require('fs');
var path = require('path');

var http2 = require('../lib/http');
var https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var options = {
  key: fs.readFileSync(path.join(__dirname, '../example/localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '../example/localhost.crt')),
  log: util.log
};

http2.globalAgent = new http2.Agent({ log: util.log });

describe('http.js', function() {
  describe('Server', function() {
    describe('new Server(options)', function() {
      it('should throw if called without \'plain\' or TLS options', function() {
        expect(function() {
          new http2.Server();
        }).to.throw(Error);
      });
    });
    describe('property `timeout`', function() {
      it('should be a proxy for the backing HTTPS server\'s `timeout` property', function() {
        var server = new http2.Server(options);
        var backingServer = server._server;
        var newTimeout = 10;
        server.timeout = newTimeout;
        expect(server.timeout).to.be.equal(newTimeout);
        expect(backingServer.timeout).to.be.equal(newTimeout);
      });
    });
  });
  describe('Agent', function() {
    describe('property `maxSockets`', function() {
      it('should be a proxy for the backing HTTPS agent\'s `maxSockets` property', function() {
        var agent = new http2.Agent({ log: util.log });
        var backingAgent = agent._httpsAgent;
        var newMaxSockets = backingAgent.maxSockets + 1;
        agent.maxSockets = newMaxSockets;
        expect(agent.maxSockets).to.be.equal(newMaxSockets);
        expect(backingAgent.maxSockets).to.be.equal(newMaxSockets);
      });
    });
  });
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
              server.close();
              done();
            });
          });
        });
      });
    });
    describe('request with payload', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          request.once('readable', function() {
            expect(request.read().toString()).to.equal(message);
            response.end();
          });
        });

        server.listen(1240, function() {
          var request = http2.request({
            host: 'localhost',
            port: 1240,
            path: path
          });
          request.write(message);
          request.end();
          request.on('response', function() {
            server.close();
            done();
          });
        });
      });
    });
    describe('request with custom headers', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';
        var headerName = 'name';
        var headerValue = 'value';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          expect(request.headers[headerName]).to.equal(headerValue);
          response.setHeader(headerName, headerValue);
          expect(response.getHeader(headerName)).to.equal(headerValue);
          response.setHeader('nonexistent', 'x');
          response.removeHeader('nonexistent');
          expect(response.getHeader('nonexistent')).to.equal(undefined);
          response.end(message);
        });

        server.listen(1239, function() {
          var headers = {};
          headers[headerName] = headerValue;
          var request = http2.request({
            host: 'localhost',
            port: 1239,
            path: path,
            headers: headers
          });
          request.end();
          request.on('response', function(response) {
            expect(response.headers[headerName]).to.equal(headerValue);
            expect(response.headers['nonexistent']).to.equal(undefined);
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              server.close();
              done();
            });
          });
        });
      });
    });
    describe('request over plain TCP', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer({
          plain: true,
          log: util.log
        }, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1237, function() {
          var request = http2.request({
            plain: true,
            host: 'localhost',
            port: 1237,
            path: path
          }, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              server.close();
              done();
            });
          });
          request.end();
        });
      });
    });
    describe('request to an HTTPS/1 server', function() {
      it('should fall back to HTTPS/1 successfully', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = https.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(5678, function() {
          http2.get('https://localhost:5678' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
    describe('HTTPS/1 request to a HTTP/2 server', function() {
      it('should fall back to HTTPS/1 successfully', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1236, function() {
          https.get('https://localhost:1236' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
    describe('two parallel request', function() {
      it('should work as expected', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1237, function() {
          done = util.callNTimes(2, done);
          // 1. request
          http2.get('https://localhost:1237' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
          // 2. request
          http2.get('https://localhost:1237' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);
              done();
            });
          });
        });
      });
    });
    describe('two subsequent request', function() {
      it('should use the same HTTP/2 connection', function(done) {
        var path = '/x';
        var message = 'Hello world';

        var server = http2.createServer(options, function(request, response) {
          expect(request.url).to.equal(path);
          response.end(message);
        });

        server.listen(1238, function() {
          // 1. request
          http2.get('https://localhost:1238' + path, function(response) {
            response.on('readable', function() {
              expect(response.read().toString()).to.equal(message);

              // 2. request
              http2.get('https://localhost:1238' + path, function(response) {
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
