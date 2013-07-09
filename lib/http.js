// This is the main API that can be used to create HTTP/2 server that does not run on top of TLS.
var http2 = exports;

// The main governing power behind the http2 API design is that it should look very similar to the
// existing node.js [HTTP](http://nodejs.org/api/http.html)/[HTTPS](http://nodejs.org/api/https.html)
// APIs. The additional features of HTTP/2 are exposed as extensions to these APIs. Furthermore,
// node-http2 should fall back to using HTTP/1.1 if needed.
var http = require('http');

http2.STATUS_CODES = http.STATUS_CODES;

// This should hold sane defaults for mandatory settings. These can be overridden by the user
// using the options configuration object in client and server APIs.
var default_settings = {};

// Server
// ------

// Deviation from the original http API: there's and `options` optional argument. Values in it can
// override the default settings.
http2.createServer = function createServer(options, requestListener) {
};

// Client
// ------

// Implementation hints:
//
// Settings encoding:
// ```
// var buffers = [], Serializer = require('./framer').Serializer;
// Serializer.SETTINGS({ settings: { k1: v1, k2: v2 } }, buffers);
// var result = buffers[0];
// ```
//
// Once handshake is complete and switching to HTTP2 mode
//
//  * create a `require('./connection').Connection` object, with
//  * `'CLIENT'` as `role`
//  * the used TCP stream as `socket`
//  * the used settings as `settings`
//  * the initial `req` and `res` object as `initialRequest` and `initialResponse`
http2.request = function request(options, callback) {
};

http2.get = function get(options, callback) {
};

// Agent
// -----

// [HTTP agents](http://nodejs.org/api/http.html#http_class_http_agent) are not yet supported,
// so every client request will create a new TCP stream.
