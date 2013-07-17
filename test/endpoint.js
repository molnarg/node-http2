var expect = require('chai').expect;

var endpoint = require('../lib/endpoint');
var Endpoint = endpoint.Endpoint;
var Server   = endpoint.Server;
var Client   = endpoint.Client;

describe('endpoint.js', function() {
  describe('scenario', function() {
    describe('connection setup', function() {
      it('should work as expected', function(done) {
        var c = new Client();
        var s = new Server();

        c.pipe(s).pipe(c);

        setTimeout(function() {
          // If there are no exception until this, then we're done
          done();
        }, 10);
      });
    });
  });
});
