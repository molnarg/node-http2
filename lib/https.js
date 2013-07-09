// This is the main API that can be used to create HTTP/2 server that runs on top of TLS.
var https2 = exports;

// The main governing power behind the http2 API design is that it should look very similar to the
// existing node.js [HTTP](http://nodejs.org/api/http.html)/[HTTPS](http://nodejs.org/api/https.html)
// APIs. The additional features of HTTP/2 are exposed as extensions to these APIs. Furthermore,
// node-http2 should fall back to using HTTP/1.1 if needed.
var https = require('https');

var default_settings = {};

// Server
// ------

https2.createServer = function createServer(options, requestListener) {
};

// Client
// ------

https2.request = function request(options, callback) {
};

https2.get = function get(options, callback) {
};

// Agent
// -----

// [HTTPS agents](http://nodejs.org/api/https.html#https_class_https_agent) are not yet supported,
// so every client request will create a new TCP stream.
