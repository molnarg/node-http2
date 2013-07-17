var expect = require('chai').expect;

var Connection = require('../lib/connection').Connection;

describe('connection.js', function() {
  describe('scenario', function() {
    describe('connection setup', function() {
      it('should work as expected', function(done) {
        var c = new Connection(1, {});
        var s = new Connection(2, {});

        c.pipe(s).pipe(c);

        setTimeout(function() {
          // If there are no exception until this, then we're done
          done();
        }, 10);
      });
    });
  });
});
