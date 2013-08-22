var expect = require('chai').expect;
var util = require('./util');

var endpoint = require('../lib/endpoint');
var Endpoint = endpoint.Endpoint;

var settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 100,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

describe('endpoint.js', function() {
  describe('scenario', function() {
    describe('connection setup', function() {
      it('should work as expected', function(done) {
        var c = new Endpoint('CLIENT', settings, util.log.child({ role: 'client' }));
        var s = new Endpoint('SERVER', settings, util.log.child({ role: 'server' }));

        util.log.debug('Test initialization over, starting piping.');
        c.pipe(s).pipe(c);

        setTimeout(function() {
          // If there are no exception until this, then we're done
          done();
        }, 10);
      });
    });
  });
});
