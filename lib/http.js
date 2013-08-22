// Public API
// ==========

// The main governing power behind the http2 API design is that it should look very similar to the
// existing node.js [HTTPS API][1] (which is, in turn, almost identical to the [HTTP API][2]). The
// additional features of HTTP/2 are exposed as extensions to this API. Furthermore, node-http2
// should fall back to using HTTP/1.1 if needed. Compatibility with undocumented or deprecated
// elements of the node.js HTTP/HTTPS API is a non-goal.
//
// Additional and modified API elements:
//
// - **Class: http2.Server**
//   - **Event: 'upgrade'**: upgrade is deprecated in HTTP/2 so it will never be emitted for HTTP/2
//     requests.
//   - **Event: 'connection' (socket, [endpoint])**: there's a second argument if the negotiation of
//     HTTP/2 was successful: the reference to the [Endpoint](endpoint.html) object tied to the
//     socket.
//   - **Event: 'timeout'**: only emitted for HTTP/1 responses.
//   - **server.setTimeout(msecs, callback)**: only affects HTTP/1 connections.
//   - **server.timeout**: only affects HTTP/1 connections.
//
// - **http2.createServer(options, [requestListener])**: additional option:
//   - **log**: an optional [bunyan](https://github.com/trentm/node-bunyan) logger object
//
// - **Class: http2.ServerResponse**
//   - **Event: 'timeout'**: only emitted for HTTP/1 responses.
//   - **response.push(options)**: initiates a server push. `options` describes the 'imaginary'
//     request to which the push stream is a response; the possible options are identical to the
//     ones accepted by `http2.request`. Returns a ServerResponse object that can be used to send
//     the response headers and content.
//   - **response.writeHead(statusCode, [reasonPhrase], [headers])**: reasonPhrase will always be
//     ignored since [it's not supported in HTTP/2][3]
//   - **response.setTimeout(timeout, [callback])**: will be ignored for HTTP/2 requests
//
// - **Class: http2.Agent**
//   - **new Agent(options)**: additional option:
//     - **log**: an optional [bunyan](https://github.com/trentm/node-bunyan) logger object
//
// - **Class: http2.ClientRequest**
//   - **Event: 'upgrade'**: upgrade is deprecated in HTTP/2 so it will never be emitted for HTTP/2
//     requests.
//   - **Event: 'socket' (socket)**: in case of an HTTP/2 incoming message, `socket` is a reference
//     to the associated [HTTP/2 Stream](stream.html) object (and not to the TCP socket).
//   - **request.setTimeout(timeout, [callback])**: will be ignored for HTTP/2 requests
//   - **request.setNoDelay([noDelay])**: will be ignored for HTTP/2 requests
//   - **request.setSocketKeepAlive([enable], [initialDelay])**: will be ignored for HTTP/2 requests
//   - **request.setPriority(priority)**: assign a priority to this request. `priority` is a number
//     between 0 (highest priority) and 2^31-1 (lowest priority). Default value is 2^30.
//
// - **Class: http2.IncomingMessage**
//   - has two subclasses for easier interface description: **IncomingRequest** and
//     **IncomingResponse**
//   - **message.socket**: in case of an HTTP/2 incoming message, it's a reference to the associated
//     [HTTP/2 Stream](stream.html) object (and not to the TCP socket).
//   - **message.setTimeout(timeout, [callback])**: will be ignored for HTTP/2 requests
//
// - **Class: http2.IncomingRequest (IncomingMessage)**
//   - **message.url**: in case of an HTTP/2 incoming request, the `url` field always contains the
//     path, and never a full url (it contains the path in most cases in the HTTPS api as well).
//   - **message.scheme**: additional field. Mandatory HTTP/2 request metadata.
//   - **message.host**: additional field. Mandatory HTTP/2 request metadata. Note that this
//     replaces the old Host header field, but node-http2 will add Host to the `message.headers` for
//     backwards compatibility.
//
// - **Class: http2.IncomingResponse (IncomingMessage)**
//   - **Event: 'push' (promise)**: signals the intention of a server push. `promise` is an
//     IncomingPromise. If there's no listener for this event, the server push is cancelled.
//
// - **Class: http2.IncomingPromise (IncomingRequest)**
//   - contains the metadata of the 'imaginary' request to which the server push is an answer.
//   - **Event: 'response' (response)**: signals the arrival of the actual push stream. `response`
//     is an IncomingResponse.
//   - **promise.cancel()**: cancels the promised server push.
//   - **promise.setPriority(priority)**: assign a priority to this push stream. `priority` is a
//     number between 0 (highest priority) and 2^31-1 (lowest priority). Default value is 2^30.
//
// API elements not yet implemented:
//
// - **Class: http2.Server**
//   - **Event: 'checkContinue'**
//   - **Event: 'connect'**
//   - **Event: 'clientError'**
//   - **server.maxHeadersCount**
//
// - **Class: http2.ServerResponse**
//   - **Event: 'close'**
//   - **response.writeContinue()**
//   - **response.addTrailers(headers)**
//
// - **http.request(options, callback)**: not implemented options:
//   - **auth**
//   - **agent**
//
// - **Class: http2.Agent**
//   - **agent.maxSockets**
//   - **agent.sockets**
//   - **agent.requests**
//
// - **Class: http2.ClientRequest**
//   - **Event: 'connect'**
//   - **Event: 'continue'**
//   - **request.abort()**
//
// - **Class: http2.IncomingMessage**
//   - **Event: 'close'**
//   - **message.trailers**
//
// [1]: http://nodejs.org/api/https.html
// [2]: http://nodejs.org/api/http.html
// [3]: http://tools.ietf.org/html/draft-ietf-httpbis-http2-04#section-8.1.3

// Common server and client side code
// ==================================

var net = require('net');
var url = require('url');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('stream').PassThrough;
var Readable = require('stream').Readable;
var Writable = require('stream').Writable;
var Endpoint = require('./endpoint').Endpoint;
var http = require('http');
var https = require('https');

exports.STATUS_CODES = http.STATUS_CODES;
exports.IncomingMessage = IncomingMessage;
exports.OutgoingMessage = OutgoingMessage;

// The implemented version of the HTTP/2 specification is [draft 04][1].
// [1]: http://tools.ietf.org/html/draft-ietf-httpbis-http2-04
var implementedVersion = 'HTTP-draft-04/2.0';

// Logging
// -------

// Logger shim, used when no logger is provided by the user.
function noop() {}
var defaultLogger = {
  fatal: noop,
  error: noop,
  warn : noop,
  info : noop,
  debug: noop,
  trace: noop,

  child: function() { return this; }
};

// Bunyan serializers exported by submodules that are worth adding when creating a logger.
exports.serializers = {};
var modules = ['./framer', './compressor', './flow', './connection', './stream', './endpoint'];
modules.forEach(function(module) {
  util._extend(exports.serializers, require(module).serializers);
});

// IncomingMessage class
// ---------------------

function IncomingMessage(stream) {
  // * This is basically a read-only wrapper for the [Stream](stream.html) class.
  PassThrough.call(this);
  stream.pipe(this);
  this.socket = this.stream = stream;

  this._log = stream._log.child({ component: 'http' });

  // * HTTP/2.0 does not define a way to carry the version identifier that is included in the
  //   HTTP/1.1 request/status line. Version is always 2.0.
  this.httpVersion = '2.0';
  this.httpVersionMajor = 2;
  this.httpVersionMinor = 0;

  // * Other metadata is filled in when the headers arrive.
  stream.once('headers', this._onHeaders.bind(this));
}
IncomingMessage.prototype = Object.create(PassThrough.prototype, { constructor: { value: IncomingMessage } });

IncomingMessage.prototype.setTimeout = function noop() {};

// OutgoingMessage class
// ---------------------

function OutgoingMessage() {
  // * This is basically a read-only wrapper for the [Stream](stream.html) class.
  Writable.call(this);

  this._headers = {};
  this.headersSent = false;

  this.on('finish', this._finish.bind(this));
}
OutgoingMessage.prototype = Object.create(Writable.prototype, { constructor: { value: OutgoingMessage } });

OutgoingMessage.prototype._write = function _write(chunk, encoding, callback) {
  if (this.stream) {
    this.stream.write(chunk, encoding, callback);
  } else {
    this.once('socket', this._write.bind(this, chunk, encoding, callback));
  }
};

OutgoingMessage.prototype._finish = function _finish() {
  if (this.stream) {
    this.stream.end();
  } else {
    this.once('socket', this._finish.bind(this));
  }
};

OutgoingMessage.prototype.setHeader = function setHeader(name, value) {
  if (this.headersSent) {
    throw new Error('Can\'t set headers after they are sent.');
  } else {
    this._headers[name.toLowerCase()] = value;
  }
};

OutgoingMessage.prototype.removeHeader = function removeHeader(name) {
  if (this.headersSent) {
    throw new Error('Can\'t remove headers after they are sent.');
  } else {
    delete this._headers[name.toLowerCase()];
  }
};

OutgoingMessage.prototype.getHeader = function getHeader(name) {
  return this._headers[name.toLowerCase()];
};

IncomingMessage.prototype.setTimeout = function noop() {};

// Server side
// ===========

exports.createServer = createServer;
exports.Server = Server;
exports.IncomingRequest = IncomingRequest;
exports.OutgoingResponse = OutgoingResponse;
exports.ServerResponse = OutgoingResponse; // for API compatibility

// Server class
// ------------

function Server(options) {
  options = options || {};

  this._log = (options.log || defaultLogger).child({ component: 'http' });
  this._settings = options.settings;

  var start = this._start.bind(this);
  var fallback = this._fallback.bind(this);

  // HTTP2 over TLS (using NPN instean of ALPN)
  if ((options.key && options.cert) || options.pfx) {
    this._log.info('Creating HTTP/2 server over TLS/NPN');
    this._mode = 'options';
    options.NPNProtocols = [implementedVersion, 'http/1.1', 'http/1.0'];
    this._server = https.createServer(options);
    this._originalSocketListeners = this._server.listeners('secureConnection');
    this._server.removeAllListeners('secureConnection');
    this._server.on('secureConnection', function(socket) {
      if (socket.npnProtocol === implementedVersion) {
        start(socket);
      } else {
        fallback(socket);
      }
    });
    this._server.on('request', this.emit.bind(this, 'request'));
  }

  // HTTP2 over plain TCP
  else if (options.plain) {
    this._log.info('Creating HTTP/2 server over plain TCP');
    this._mode = 'plain';
    this._server = net.createServer(start);
  }

  // HTTP/2 with HTTP/1.1 upgrade
  else {
    this._log.error('Trying to create HTTP/2 server with Upgrade from HTTP/1.1');
    throw new Error('HTTP1.1 -> HTTP2 upgrade is not yet supported. Please provide TLS keys.');
  }

  this._server.on('close', this.emit.bind(this, 'close'));
}
Server.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Server } });

// Starting HTTP/2
Server.prototype._start = function _start(socket) {
  var endpoint = new Endpoint('SERVER', this._settings, this._log);

  this._log.info({ client: socket.remoteAddress + ':' + socket.remotePort, endpoint: endpoint.id },
                'New incoming HTTP/2 connection');

  endpoint.pipe(socket).pipe(endpoint);

  var self = this;
  endpoint.on('stream', function _onStream(stream) {
    var response = new OutgoingResponse(stream);
    var request = new IncomingRequest(stream);

    request.once('ready', self.emit.bind(self, 'request', request, response));
  });

  this.emit('connection', socket, endpoint);
};

Server.prototype._fallback = function _fallback(socket) {
  this._log.info({ client: socket.remoteAddress + ':' + socket.remotePort, protocol: socket.npnProtocol },
                 'Falling back to simple HTTPS');

  for (var i = 0; i < this._originalSocketListeners.length; i++) {
    this._originalSocketListeners[i].call(this._server, socket);
  }

  this.emit('connection', socket);
};

// There are [3 possible signatures][1] of the `listen` function. Every arguments is forwarded to
// the backing TCP or HTTPS server.
// [1]: http://nodejs.org/api/http.html#http_server_listen_port_hostname_backlog_callback
Server.prototype.listen = function listen(port, hostname) {
  this._log.info({ on: ((typeof hostname === 'string') ? (hostname + ':' + port) : port) },
                 'Listening for incoming connections');
  this._server.listen.apply(this._server, arguments);
};

Server.prototype.close = function close(callback) {
  this._log.info('Closing server');
  this._server.close(callback);
};

OutgoingRequest.prototype.setTimeout = function setTimeout(timeout, callback) {
  if (this._mode === 'options') {
    this._server.setTimeout(timeout, callback);
  }
};

Object.defineProperty(OutgoingRequest.prototype, 'timeout', {
  get: function getTimeout() {
    if (this._mode === 'options') {
      return this._server.timeout;
    }
  },
  set: function setTimeout(timeout) {
    if (this._mode === 'options') {
      this._server.timeout = timeout;
    }
  }
});

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain subscriptions to
// `server`.There are events on the `http.Server` class where it makes difference whether someone is
// listening on the event or not. In these cases, we can not simply forward the events from the
// `server` to `this` since that means a listener. Instead, we forward the subscriptions.
Server.prototype.on = function on(event, listener) {
  if ((event === 'upgrade') || (event === 'timeout')) {
    this._server.on(event, listener.bind(this));
  } else {
    EventEmitter.prototype.on.call(this, event, listener);
  }
};

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

// IncomingRequest class
// ---------------------

function IncomingRequest(stream) {
  IncomingMessage.call(this, stream);
}
IncomingRequest.prototype = Object.create(IncomingMessage.prototype, { constructor: { value: IncomingRequest } });

// [Request Header Fields](http://tools.ietf.org/html/draft-ietf-httpbis-http2-05#section-8.1.2.1)
// * `headers` argument: HTTP/2.0 request and response header fields carry information as a series
//   of key-value pairs. This includes the target URI for the request, the status code for the
//   response, as well as HTTP header fields.
IncomingRequest.prototype._onHeaders = function _onHeaders(headers) {
  // * An HTTP/2.0 request MUST NOT include any of the following header fields: Connection, Host,
  //   Keep-Alive, Proxy-Connection, TE, Transfer-Encoding, and Upgrade. A server MUST treat the
  //   presence of any of these header fields as a stream error of type PROTOCOL_ERROR.
  var deprecatedHeaders = [
    'connection',
    'host',
    'keep-alive',
    'proxy-connection',
    'te',
    'transfer-encoding',
    'upgrade'
  ];
  for (var i = 0; i < deprecatedHeaders.length; i++) {
    var key = deprecatedHeaders[i];
    if (key in headers) {
      this._log.error({ key: key, value: headers[key] }, 'Deprecated header found');
      this.stream.emit('error', 'PROTOCOL_ERROR');
      return;
    }
  }

  // `this.headers` will store the regular headers (and none of the special colon headers)
  this.headers = {};

  // * The ":method" header field includes the HTTP method
  // * The ":scheme" header field includes the scheme portion of the target URI
  // * The ":host" header field includes the authority portion of the target URI
  // * The ":path" header field includes the path and query parts of the target URI.
  //   This field MUST NOT be empty; URIs that do not contain a path component MUST include a value
  //   of '/', unless the request is an OPTIONS request for '*', in which case the ":path" header
  //   field MUST include '*'.
  // * All HTTP/2.0 requests MUST include exactly one valid value for all of these header fields. A
  //   server MUST treat the absence of any of these header fields, presence of multiple values, or
  //   an invalid value as a stream error of type PROTOCOL_ERROR.
  var mapping = {
    ':method': 'method',
    ':scheme': 'scheme',
    ':host': 'host',
    ':path': 'url'
  };
  for (var name in headers) {
    if (name in mapping) {
      var value = headers[name];
      if ((typeof value !== 'string') || (value.length === 0)) {
        this._log.error({ key: name, value: value }, 'Invalid header field');
        this.stream.emit('error', 'PROTOCOL_ERROR');
        return;
      }
      this[mapping[name]] = value;
    } else {
      this.headers[name] = headers[name];
    }
  }

  // * Host header is included in the headers object for backwards compatibility.
  this.headers.host = this.host;

  // * Signaling that the header arrived.
  this._log.info({ method: this.method, scheme: this.scheme, host: this.host,
                   path: this.url, headers: this.headers }, 'Incoming request');
  this.emit('ready');
};

// OutgoingResponse class
// ----------------------

function OutgoingResponse(stream) {
  OutgoingMessage.call(this);

  this._log = stream._log.child({ component: 'http' });

  this.stream = stream;
  this.statusCode = undefined;
  this.sendDate = true;

  this.stream.once('headers', this._onRequestHeaders.bind(this));
}
OutgoingResponse.prototype = Object.create(OutgoingMessage.prototype, { constructor: { value: OutgoingResponse } });

OutgoingResponse.prototype.writeHead = function writeHead(statusCode, reasonPhrase, headers) {
  if (typeof reasonPhrase === 'string') {
    this._log.warn('Reason phrase argument was present but ignored by the writeHead method');
  } else {
    headers = reasonPhrase;
  }

  headers = headers || {};

  for (var name in headers) {
    this._headers[name.toLowerCase()] = headers[name];
  }

  if (this.sendDate && !('date' in this._headers)) {
    this._headers.date = (new Date()).toUTCString();
  }

  this._log.info({ status: statusCode, headers: this._headers }, 'Sending server response');

  this._headers[':status'] = this.statusCode = statusCode;

  this.stream.headers(this._headers);

  this.headersSent = true;
};

OutgoingResponse.prototype._implicitHeaders = function _implicitHeaders() {
  if (!this.headersSent) {
    this.writeHead(this.statusCode);
  }
};

OutgoingResponse.prototype.write = function write() {
  this._implicitHeaders();
  return OutgoingMessage.prototype.write.apply(this, arguments);
};

OutgoingResponse.prototype.end = function end() {
  this._implicitHeaders();
  return OutgoingMessage.prototype.end.apply(this, arguments);
};

OutgoingResponse.prototype._onRequestHeaders = function _onRequestHeaders(headers) {
  this._requestHeaders = headers;
};

OutgoingResponse.prototype.push = function push(options) {
  if (!this.headersSent) {
    throw new Error('Initiating a server push is only possible after the head of the parent ' +
                    'request is sent.');
  }

  if (typeof options === 'string') {
    options = url.parse(options);
  }

  if (!options.path) {
    throw new Error('`path` option is mandatory.');
  }

  var promise = util._extend({
    ':method': (options.method || 'GET').toUpperCase(),
    ':scheme': (options.protocol && options.protocol.slice(0, -1)) || this._requestHeaders[':scheme'],
    ':host': options.hostname || options.host || this._requestHeaders[':host'],
    ':path': options.path
  }, options.headers);

  this._log.info({ method: promise[':method'], scheme: promise[':scheme'], host: promise[':host'],
                   path: promise[':path'], headers: options.headers }, 'Promising push stream');

  var pushStream = this.stream.promise(promise);

  return new OutgoingResponse(pushStream);
};

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain subscriptions to
// `request`. See `Server.prototype.on` for explanation.
OutgoingResponse.prototype.on = function on(event, listener) {
  if (this.request && (event === 'timeout')) {
    this.request.on(event, listener.bind(this));
  } else {
    OutgoingMessage.prototype.on.call(this, event, listener);
  }
};

// Client side
// ===========

exports.ClientRequest = OutgoingRequest; // for API compatibility
exports.OutgoingRequest = OutgoingRequest;
exports.IncomingResponse = IncomingResponse;
exports.Agent = Agent;
exports.globalAgent = undefined;
exports.request = function request(options, callback) {
  return exports.globalAgent.request(options, callback);
};
exports.get = function get(options, callback) {
  return exports.globalAgent.get(options, callback);
};

// Agent class
// -----------

function Agent(options) {
  EventEmitter.call(this);

  options = options || {};

  this._settings = options.settings;
  this._log = (options.log || defaultLogger).child({ component: 'http' });
  this._endpoints = {};

  // * Using an own HTTPS agent, because the global agent does not look at `NPNProtocols` when
  //   generating the key identifying the connection, so we may get useless non-negotiated TLS
  //   channels even if we ask for a negotiated one. This agent will contain only negotiated
  //   channels.
  this._httpsAgent = new https.Agent({
    NPNProtocols: [implementedVersion, 'http/1.1', 'http/1.0']
  });
}
Agent.prototype = Object.create(EventEmitter.prototype, { constructor: { value: Agent } });

Agent.prototype.request = function request(options, callback) {
  if (typeof options === 'string') {
    options = url.parse(options);
  }

  options.method = (options.method || 'GET').toUpperCase();
  options.protocol = options.protocol || 'https:';
  options.host = options.hostname || options.host || 'localhost';
  options.port = options.port || 443;
  options.path = options.path || '/';

  if (options.protocol === 'http') {
    this._log.error('Trying to negotiate client request with Upgrade from HTTP/1.1');
    throw new Error('HTTP1.1 -> HTTP2 upgrade is not yet supported.');
  }

  var request = new OutgoingRequest(this._log);

  if (callback) {
    request.on('response', callback);
  }

  var key = [options.host, options.port].join(':');

  // * There's an existing HTTP/2 connection to this host
  if (key in this._endpoints) {
    var endpoint = this._endpoints[key];
    request._start(endpoint.createStream(), options);
  }

  // * HTTP/2 over TLS negotiated using NPN (or later ALPN)
  //   * if the negotiation is unsuccessful
  //     * adding socket to the HTTPS agent's socket pool
  //     * initiating a request with the HTTPS agent
  //     * calling request's fallback() to fall back to use the new request object
  else {
    var started = false;
    options.NPNProtocols = [implementedVersion, 'http/1.1', 'http/1.0'];
    options.agent = this._httpsAgent;
    var httpsRequest = https.request(options);
    httpsRequest.on('socket', function(socket) {
      if (socket.npnProtocol !== undefined) {
        negotiated();
      } else {
        socket.on('secureConnect', negotiated);
      }
    });

    var negotiated = function negotiated() {
      if (!started) {
        if (httpsRequest.socket.npnProtocol === implementedVersion) {
          httpsRequest.socket.emit('agentRemove');
          unbundleSocket(httpsRequest.socket);
          var endpoint = new Endpoint('CLIENT', this._settings, this._log);
          this._log.info({ server: options.host + ':' + options.port, endpoint: endpoint.id },
                         'New outgoing HTTP/2 connection');
          endpoint.socket = httpsRequest.socket;
          endpoint.pipe(endpoint.socket).pipe(endpoint);
          this._endpoints[key] = endpoint;
          this.emit(key, endpoint);
        } else {
          this.emit(key, undefined);
        }
      }
    }.bind(this);

    this.once(key, function(endpoint) {
      started = true;
      if (endpoint) {
        request._start(endpoint.createStream(), options);
      } else {
        request._fallback(httpsRequest);
      }
    });
  }

  return request;
};

Agent.prototype.get = function get(options, callback) {
  var request = this.request(options, callback);
  request.end();
  return request;
};

function unbundleSocket(socket) {
  socket.removeAllListeners('data');
  socket.removeAllListeners('end');
  socket.removeAllListeners('readable');
  socket.removeAllListeners('close');
  socket.removeAllListeners('error');
  socket.unpipe();
  delete socket.ondata;
  delete socket.onend;
}

exports.globalAgent = new Agent();

// OutgoingRequest class
// ---------------------

function OutgoingRequest() {
  OutgoingMessage.call(this);

  this._log = undefined;

  this.stream = undefined;
  this.headersSent = true;
}
OutgoingRequest.prototype = Object.create(OutgoingMessage.prototype, { constructor: { value: OutgoingRequest } });

OutgoingRequest.prototype._start = function _start(stream, options) {
  this.stream = stream;

  this._log = stream._log.child({ component: 'http' });

  var headers = {};
  for (var key in options.headers) {
    headers[key] = options.headers[key];
  }
  delete headers.host;
  headers[':scheme'] = options.protocol.slice(0, -1);
  headers[':method'] = options.method;
  headers[':host'] = options.hostname;
  headers[':path'] = options.path;

  this._log.info({ scheme: headers[':scheme'], method: headers[':method'], host: headers[':host'],
                   path: headers[':path'], headers: (options.headers || {}) }, 'Sending request');
  this.stream.headers(headers);

  this.emit('socket', this.stream);

  var response = new IncomingResponse(this.stream);
  response.once('ready', this.emit.bind(this, 'response', response));
};

OutgoingRequest.prototype._fallback = function _fallback(request) {
  this.stream = request;
  this.emit('socket', this.socket);

  this.pipe(request);
};

OutgoingRequest.prototype.setPriority = function setPriority(priority) {
  if (this.stream) {
    this.stream.priority(priority);
  } else {
    this.once('socket', this.setPriority.bind(this, priority));
  }
};

// Overriding `EventEmitter`'s `on(event, listener)` method to forward certain subscriptions to
// `request`. See `Server.prototype.on` for explanation.
OutgoingRequest.prototype.on = function on(event, listener) {
  if (this.request && (event === 'upgrade')) {
    this.request.on(event, listener.bind(this));
  } else {
    OutgoingMessage.prototype.on.call(this, event, listener);
  }
};

// Methods only in fallback mode
OutgoingRequest.prototype.setNoDelay = function setNoDelay(noDelay) {
  if (this.request) {
    this.request.setNoDelay(noDelay);
  }
};

OutgoingRequest.prototype.setSocketKeepAlive = function setSocketKeepAlive(enable, initialDelay) {
  if (this.request) {
    this.request.setSocketKeepAlive(enable, initialDelay);
  }
};

OutgoingRequest.prototype.setTimeout = function setTimeout(timeout, callback) {
  if (this.request) {
    this.request.setTimeout(timeout, callback);
  }
};

// IncomingResponse class
// ----------------------

function IncomingResponse(stream) {
  IncomingMessage.call(this, stream);
  stream.on('promise', this._onPromise.bind(this));
}
IncomingResponse.prototype = Object.create(IncomingMessage.prototype, { constructor: { value: IncomingResponse } });

// [Response Header Fields](http://tools.ietf.org/html/draft-ietf-httpbis-http2-05#section-8.1.2.2)
IncomingResponse.prototype._onHeaders = function _onHeaders(headers) {
  // * HTTP/2.0 request and response header fields carry information as a series of key-value pairs.
  //   This includes the target URI for the request, the status code for the response, as well as
  //   HTTP header fields.
  this.headers = headers;

  // * A single ":status" header field is defined that carries the HTTP status code field. This
  //   header field MUST be included in all responses.
  // * A client MUST treat the absence of the ":status" header field, the presence of multiple
  //   values, or an invalid value as a stream error of type PROTOCOL_ERROR.
  // * HTTP/2.0 does not define a way to carry the reason phrase that is included in an HTTP/1.1
  //   status line.
  var statusCode = headers[':status'];
  if ((typeof statusCode !== 'string') || (statusCode.length === 0)) {
    this._log.error({ key: ':status', value: statusCode }, 'Invalid header field');
    this.stream.emit('error', 'PROTOCOL_ERROR');
    return;
  }
  this.statusCode = statusCode;
  delete headers[':status'];

  // * Signaling that the header arrived.
  this._log.info({ status: statusCode, headers: headers}, 'Incoming response');
  this.emit('ready');
};

IncomingResponse.prototype._onPromise = function _onPromise(stream, headers) {
  var promise = new IncomingPromise(stream, headers);

  if (this.listeners('push').length > 0) {
    this.emit('push', promise);
  } else {
    promise.cancel();
  }
};

// IncomingPromise class
// -------------------------

function IncomingPromise(responseStream, promiseHeaders) {
  var stream = new Readable();
  stream._read = function noop() {};
  stream.push(null);
  stream._log = responseStream._log;

  IncomingRequest.call(this, stream);

  stream.emit('headers', promiseHeaders);

  this._responseStream = responseStream;

  var response = new IncomingResponse(this._responseStream);
  response.once('ready', this.emit.bind(this, 'response', response));
}
IncomingPromise.prototype = Object.create(IncomingRequest.prototype, { constructor: { value: IncomingPromise } });

IncomingPromise.prototype.cancel = function cancel() {
  this._responseStream.reset('CANCEL');
};

IncomingPromise.prototype.setPriority = function setPriority(priority) {
  this._responseStream.priority(priority);
};
