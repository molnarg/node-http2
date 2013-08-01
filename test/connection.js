var expect = require('chai').expect;
var log_root = require('../lib/logging').root;

var Connection = require('../lib/connection').Connection;

var settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 100,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

describe('connection.js', function() {
  describe('scenario', function() {
    describe('connection setup', function() {
      it('should work as expected', function(done) {
        var c = new Connection(1, settings);
        var s = new Connection(2, settings);

        c.pipe(s).pipe(c);

        setTimeout(function() {
          // If there are no exception until this, then we're done
          done();
        }, 10);
      });
    });
    describe('sending/receiving a request', function() {
      it('should work as expected', function(done) {
        var c = new Connection(1, settings, log_root.child({ role: 'client' }));
        var s = new Connection(2, settings, log_root.child({ role: 'server' }));

        c.pipe(s).pipe(c);

        // Request and response data
        var request_headers = {
          ':method': 'GET',
          ':path': '/'
        };
        var request_data = new Buffer(0);
        var response_headers = {
          ':status': '200'
        };
        var response_data = new Buffer('12345678', 'hex');

        // Setting up server
        s.on('stream', function(server_stream) {
          server_stream.on('headers', function(headers) {
            expect(headers).to.deep.equal(request_headers);
            server_stream.headers(response_headers);
            server_stream.end(response_data);
          });
        });

        // Sending request
        var client_stream = c.createStream();
        client_stream.headers(request_headers);
        client_stream.end(request_data);

        // Waiting for answer
        var headers_arrived = false;
        var data_arrived = false;
        client_stream.on('headers', function(headers) {
          expect(headers).to.deep.equal(response_headers);
          headers_arrived = true;
        });
        client_stream.on('data', function(chunk) {
          expect(chunk).to.deep.equal(response_data);
          data_arrived = true;
        });
        client_stream.on('end', function() {
          expect(headers_arrived).to.equal(true);
          expect(data_arrived).to.equal(true);
          done();
        });
      });
    });
  });
});
