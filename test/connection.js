var expect = require('chai').expect;

var Connection = require('../lib/connection').Connection;

var log;
if (process.env.HTTP2_LOG) {
  log = require('bunyan').createLogger({ name: 'http2', level: process.env.HTTP2_LOG });
}

describe('connection.js', function() {
  describe('scenario', function() {
    describe('connection setup', function() {
      it('should work as expected', function(done) {
        var c = new Connection(1, {}, log);
        var s = new Connection(2, {}, log);

        c.pipe(s).pipe(c);

        setTimeout(function() {
          // If there are no exception until this, then we're done
          done();
        }, 10);
      });
    });
  });
});
