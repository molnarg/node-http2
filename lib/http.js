var net = require('net');
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('stream').PassThrough;
var Endpoint = require('./endpoint').Endpoint;

// This is the main API that can be used to create HTTP/2 servers.
var http2 = exports;

// The implemented draft is [http2-04](http://tools.ietf.org/html/draft-ietf-httpbis-http2-04).
var implementedVersion = 'HTTP-draft-04/2.0';

// The main governing power behind the http2 API design is that it should look very similar to the
// existing node.js [HTTP](http://nodejs.org/api/http.html)/[HTTPS](http://nodejs.org/api/https.html)
// APIs. The additional features of HTTP/2 are exposed as extensions to these APIs. Furthermore,
// node-http2 should fall back to using HTTP/1.1 if needed.
var http = require('http');
var https = require('https');

http2.STATUS_CODES = http.STATUS_CODES;

// This should hold sane defaults for mandatory settings. These can be overridden by the user
// using the options configuration object in client and server APIs.
var default_settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 100,
  SETTINGS_INITIAL_WINDOW_SIZE: 100000
};

// Server
// ------

// Deviation from the original http API: there's and `options` optional argument. Values in it can
// override the default settings.
http2.createServer = createServer;
http2.Server = Server;

function createServer(options, requestListener) {
  if (typeof options === 'function') {
    requestListener = options;
    options = undefined;
  }

  var server = new Server(options);

  if (requestListener) {
    server.on('request', requestListener);
  }

  return server;
}

function Server(options) {
  options = options || {};

  this._settings = options.settings;

  // HTTP2 over TLS (using NPN instean of ALPN)
  if ((options.key && options.cert) || options.pfx) {
    this._server = https.createServer(options);
    this._originalSocketListeners = this._server.listeners('secureConnection');
    this._server.removeAllListeners('secureConnection');
    this._server.on('secureConnection', this._onSecureConnection.bind(this));
    this._server.on('request', this.emit.bind(this, 'request'));
  }

  // HTTP2 over plain TCP
  else if (options.plain) {
    this._server = net.createServer(this._start.bind(this));
  }

  // HTTP/2 with HTTP/1.1 upgrade
  else {
    throw new Error('HTTP1.1 -> HTTP2 upgrade is not yet supported. Please provide TLS keys.');
  }
}
Server.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Server } });

Server.prototype._onSecureConnection = function _onSecureConnection(socket) {
  // Upgrading only if the NPN negotiation was successful
  if (socket.npnProtocol === implementedVersion) {
    this._start(socket);
  }

  // Fallback to https
  else {
    for (var i = 0; i < this._originalSocketListeners.length; i++) {
      this._originalSocketListeners[i].call(this._server, socket);
    }
  }
};

// Starting HTTP/2
Server.prototype._start = function _start(socket) {
  var endpoint = new Endpoint('SERVER', this._settings || default_settings);

  endpoint.pipe(socket).pipe(endpoint);

  endpoint.on('stream', this._onStream.bind(this));
};

Server.prototype._onStream = function _onStream(stream) {
  var request = new IncomingMessage(stream);
  var response = new ServerResponse(stream);

  request.once('ready', this.emit.bind(this, 'request', request, response));
};

Server.prototype.listen = function listen(port) {
  this._server.listen(port);
};

Server.prototype.close = function close() {
  this._server.close();
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

// Common IncomingMessage class
// ----------------------------

function IncomingMessage(stream) {
  PassThrough.call(this);

  this._stream = stream;

  this.httpVersion = '2.0';
  this.httpVersionMajor = 2;
  this.httpVersionMinor = 0;

  stream.pipe(this);
  stream.once('headers', this._onHeaders.bind(this));
}
IncomingMessage.prototype = Object.create(PassThrough.prototype, { constructor: { value: IncomingMessage } });

IncomingMessage.prototype._onHeaders = function(headers) {
  this.url = headers[':path'];
  this.method = headers[':method'];
  this.headers = headers;

  headers.host = headers[':host'];
  delete headers[':scheme'];
  delete headers[':method'];
  delete headers[':host'];
  delete headers[':path'];

  this.emit('ready');
};

// ServerResponse
// --------------

function ServerResponse(stream) {
  PassThrough.call(this);

  this._stream = stream;

  this.pipe(stream);
}
ServerResponse.prototype = Object.create(PassThrough.prototype, { constructor: { value: ServerResponse } });

ServerResponse.prototype.writeHead = function(statusCode, reasonPhrase, headers) {
  if (!headers) {
    headers = reasonPhrase;
  }

  headers = headers || {};

  headers[':status'] = statusCode;

  this._stream.headers(headers);
};

// Agent
// -----

// [HTTP agents](http://nodejs.org/api/http.html#http_class_http_agent) are not yet supported,
// so every client request will create a new TCP stream.
