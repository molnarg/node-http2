var expect = require('chai').expect;
var util = require('./util');

var Flow = require('../lib/flow').Flow;

function createFlow() {
  var flow = new Flow();
  flow._log = util.log;
  return flow;
}

describe('flow.js', function() {
  describe('Flow class', function() {
    var flow;
    beforeEach(function() {
      flow = createFlow();
    });

    describe('._receive(frame, callback) method', function() {
      it('is called when there\'s a frame in the input buffer to be consumed', function(done) {
        var frame = { type: 'PRIORITY', flags: {}, priority: 1 };
        flow._receive = function _receive(receivedFrame, callback) {
          expect(receivedFrame).to.equal(frame);
          callback();
        };
        flow.write(frame, done);
      });
      it('has to be overridden by the child class, otherwise it throws', function() {
        expect(flow._receive.bind(flow)).to.throw(Error);
      });
    });
    describe('._send() method', function() {
      it('is called when the output buffer should be filled with more frames and the flow' +
         'control queue is empty', function() {
        var sendCalled = 0;
        var notFlowControlledFrame = { type: 'PRIORITY', flags: {}, priority: 1 };
        flow._send = function _send() {
          sendCalled += 1;
          this.push(notFlowControlledFrame);
        };
        expect(flow.read()).to.equal(notFlowControlledFrame);

        flow._window = 0;
        flow._queue.push({ type: 'DATA', flags: {}, data: { length: 1 } });
        expect(flow.read()).to.equal(null);

        expect(sendCalled).to.equal(1);
      });
      it('has to be overridden by the child class, otherwise it throws', function() {
        expect(flow._send.bind(flow)).to.throw(Error);
      });
    });
    describe('._increaseWindow(size) method', function() {
      it('should increase `this._window` by `size`', function() {
        flow._send = util.noop;
        flow._window = 0;

        var increase1 = util.random(0,100);
        var increase2 = util.random(0,100);
        flow._increaseWindow(increase1);
        flow._increaseWindow(increase2);
        expect(flow._window).to.equal(increase1 + increase2);

        flow._increaseWindow(Infinity);
        expect(flow._window).to.equal(Infinity);
      });
      it('should emit error when increasing with a finite `size` when `_window` is infinite', function() {
        flow._send = util.noop;
        flow._increaseWindow(Infinity);
        var increase = util.random(1,100);

        expect(flow._increaseWindow.bind(flow, increase)).to.throw('Uncaught, unspecified "error" event.');
      });
      it('should emit error when `_window` grows over the window limit', function() {
        var WINDOW_SIZE_LIMIT = Math.pow(2, 31) - 1;
        flow._send = util.noop;
        flow._window = 0;

        flow._increaseWindow(WINDOW_SIZE_LIMIT);
        expect(flow._increaseWindow.bind(flow, 1)).to.throw('Uncaught, unspecified "error" event.');

      });
    });
    describe('.read() method', function() {
      describe('when the flow control queue is not empty', function() {
        it('should return the first item in the queue if the window is enough', function() {
          var priorityFrame = { type: 'PRIORITY', flags: {}, priority: 1 };
          var dataFrame = { type: 'DATA', flags: {}, data: { length: 10 } };
          flow._send = util.noop;
          flow._window = 10;
          flow._queue = [priorityFrame, dataFrame];

          expect(flow.read()).to.equal(priorityFrame);
          expect(flow.read()).to.equal(dataFrame);
        });
        it('should also split DATA frames when needed', function() {
          var buffer = new Buffer(10);
          var dataFrame = { stream: util.random(0, 100), type: 'DATA', flags: {}, data: buffer };
          flow._send = util.noop;
          flow._window = 5;
          flow._queue = [dataFrame];

          var expectedFragment = { stream: dataFrame.stream, type: 'DATA', data: buffer.slice(0,5) };
          expect(flow.read()).to.deep.equal(expectedFragment);
          expect(dataFrame.data).to.deep.equal(buffer.slice(5));
        });
      });
    });
  });
});
