var tls = require('tls');
var net = require('net');
var EventEmitter = require('events').EventEmitter;
var PassThrough = require('stream').PassThrough;
var Endpoint = require('./endpoint').Endpoint;
var logging = require('./logging');

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

// This should hold sane defaults. These can be overridden by the user using the options
// configuration object in client and server APIs.
var default_settings = {
  SETTINGS_MAX_CONCURRENT_STREAMS: 100
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

  this._log = (options.log || logging.root).child({ component: 'http' });
  this._settings = options.settings;
  this._endpoint = undefined;

  // HTTP2 over TLS (using NPN instean of ALPN)
  if ((options.key && options.cert) || options.pfx) {
    this._log.info('Creating HTTP/2 server over TLS/NPN');
    options.NPNProtocols = [implementedVersion, 'http/1.1', 'http/1.0'];
    this._server = https.createServer(options);
    this._originalSocketListeners = this._server.listeners('secureConnection');
    this._server.removeAllListeners('secureConnection');
    this._server.on('secureConnection', this._onSecureConnection.bind(this));
    this._server.on('request', this.emit.bind(this, 'request'));
  }

  // HTTP2 over plain TCP
  else if (options.plain) {
    this._log.info('Creating HTTP/2 server over plain TCP');
    this._server = net.createServer(this._start.bind(this));
  }

  // HTTP/2 with HTTP/1.1 upgrade
  else {
    this._log.error('Trying to create HTTP/2 server with Upgrade from HTTP/1.1');
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
    this._log.info({ client: socket.remoteAddress + ':' + socket.remotePort, protocol: socket.npnProtocol },
                   'Falling back to simple HTTPS');
    for (var i = 0; i < this._originalSocketListeners.length; i++) {
      this._originalSocketListeners[i].call(this._server, socket);
    }
  }
};

// Starting HTTP/2
Server.prototype._start = function _start(socket) {
  var logger = this._log.child({ client: socket.remoteAddress + ':' + socket.remotePort  });
  logger.info('Incoming HTTP/2 connection');

  this._endpoint = new Endpoint('SERVER', this._settings || default_settings, logger);

  this._endpoint.pipe(socket).pipe(this._endpoint);

  var self = this;
  this._endpoint.on('stream', function _onStream(stream) {
    var request = new IncomingMessage(stream, 'REQUEST', logger);
    var response = new ServerResponse(stream, logger);

    request.once('ready', self.emit.bind(self, 'request', request, response));
  });
};

Server.prototype.listen = function listen(port) {
  this._log.info({ port: port }, 'Listening for incoming connections');
  this._server.listen(port);
};

Server.prototype.close = function close() {
  this._log.info('Closing server');
  this._server.close();
};

// Client
// ------

http2.request = function request(options, callback) {
  var request = new ClientRequest();

  if (callback) {
    request.on('response', callback);
  }

  var tlsOptions = {
    host: options.hostname || options.host,
    port: options.port || 80,
    NPNProtocols: [implementedVersion, 'http/1.1', 'http/1.0']
  };

  var optionsToForward = [
    'pfx',
    'key',
    'passphrase',
    'cert',
    'ca',
    'ciphers',
    'rejectUnauthorized',
    'secureProtocol'
  ];
  for (var i = 0; i < optionsToForward.length; i++) {
    var key = optionsToForward[i];
    if (key in options) {
      tlsOptions[key] = options[key];
    }
  }

  var socket = tls.connect(tlsOptions, function() {
    // HTTP2 is supported!
    if (socket.npnProtocol === implementedVersion) {
      var endpoint = new Endpoint('CLIENT', options._settings || default_settings);
      endpoint.pipe(socket).pipe(endpoint);
      request._start(endpoint.createStream(), options);
    }

    // Fallback
    else {
      socket.end();
      request._fallback(https.request(options));
    }
  });

  return request;
};

http2.get = function get(options, callback) {
};

// Agent
// -----

function Agent(options) {

}

// Common IncomingMessage class
// ----------------------------

// Constructor
function IncomingMessage(stream, role, log) {
  // * This is basically a read-only wrapper for the [Stream](stream.html) class.
  PassThrough.call(this);
  stream.pipe(this);
  this._stream = stream;

  this._log = log;

  // * HTTP/2.0 does not define a way to carry the version identifier that is included in the
  //   HTTP/1.1 request/status line. Version is always 2.0.
  this.httpVersion = '2.0';
  this.httpVersionMajor = 2;
  this.httpVersionMinor = 0;

  // * Other metadata is filled in when the headers arrive.
  var onHeaders = (role === 'REQUEST') ? this._onRequestHeaders
                                       : this._onResponseHeaders;
  stream.once('headers', onHeaders.bind(this));
}
IncomingMessage.prototype = Object.create(PassThrough.prototype, { constructor: { value: IncomingMessage } });

// [Request Header Fields](http://tools.ietf.org/html/draft-ietf-httpbis-http2-05#section-8.1.2.1)
IncomingMessage.prototype._onRequestHeaders = function _onRequestHeaders(headers) {
  // * HTTP/2.0 request and response header fields carry information as a series of key-value pairs.
  //   This includes the target URI for the request, the status code for the response, as well as
  //   HTTP header fields.
  this.headers = headers;

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
    method: ':method',
    scheme: ':scheme',
    host: ':host',
    url: ':path'
  };
  for (var key in mapping) {
    var value = headers[mapping[key]];
    if ((typeof value !== 'string') || (value.length === 0)) {
      this._log.error({ key: mapping[key], value: value }, 'Invalid header field');
      this._stream.emit('error', 'PROTOCOL_ERROR');
      return;
    }
    this[key] = value;
    delete headers[mapping[key]];
  }

  // * An HTTP/2.0 request MUST NOT include any of the following header fields: Connection, Host,
  //   Keep-Alive, Proxy-Connection, TE, Transfer-Encoding, and Upgrade. A server MUST treat the
  //   presence of any of these header fields as a stream error of type PROTOCOL_ERROR.
  if (
    ('connection' in headers) ||
    ('host' in headers) ||
    ('keep-alive' in headers) ||
    ('proxy-connection' in headers) ||
    ('te' in headers) ||
    ('transfer-encoding' in headers) ||
    ('upgrade' in headers)
  ) {
    this._log.error('Deprecated header found');
    this._stream.emit('error', 'PROTOCOL_ERROR');
    return;
  }

  // * Host header is included in the headers object for backwards compatibility.
  headers.host = this.host;

  // * Signaling that the header arrived.
  this._log.info({ method: this.method, scheme: this.scheme, host: this.host,
                   path: this.url, headers: headers}, 'Incoming request');
  this.emit('ready');
};

// [Response Header Fields](http://tools.ietf.org/html/draft-ietf-httpbis-http2-05#section-8.1.2.2)
IncomingMessage.prototype._onResponseHeaders = function _onResponseHeaders(headers) {
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
    this._stream.emit('error', 'PROTOCOL_ERROR');
    return;
  }
  this.statusCode = statusCode;
  delete headers[':status'];

  // * Signaling that the header arrived.
  this._log.info({ status: statusCode, headers: headers}, 'Incoming response');
  this.emit('ready');
};

// ServerResponse
// --------------

function ServerResponse(stream, log) {
  PassThrough.call(this);

  this._log = log;
  this._stream = stream;

  this.pipe(stream);
}
ServerResponse.prototype = Object.create(PassThrough.prototype, { constructor: { value: ServerResponse } });

ServerResponse.prototype.writeHead = function writeHead(statusCode, reasonPhrase, headers) {
  if (!headers) {
    headers = reasonPhrase;
  }

  headers = headers || {};

  this._log.info({ status: statusCode, headers: headers}, 'Sending server response');

  headers[':status'] = statusCode;

  this._stream.headers(headers);
};

// ClientRequest
// -------------

function ClientRequest(log) {
  PassThrough.call(this);

  this._log = (log || logging.root).child({ component: 'http' });
  this._stream = undefined;
  this._request = undefined;
}
ClientRequest.prototype = Object.create(PassThrough.prototype, { constructor: { value: ClientRequest } });

ClientRequest.prototype._start = function _start(stream, options) {
  var logger = this._log.child({ server: (options.hostname || options.host) + ':' + (options.port || 80)  });
  logger.info('Successfully initiated HTTP/2 connection');

  var headers = {};
  for (var key in options.headers) {
    headers[key] = options.headers[key];
  }
  delete headers.host;
  headers[':scheme'] = 'https';
  headers[':method'] = options.method;
  headers[':host'] = options.hostname || options.host;
  headers[':path'] = options.url;

  logger.info({ scheme: headers[':scheme'], method: headers[':method'], host: headers[':host'],
                path: headers[':path'], headers: (options.headers || {}) }, 'Sending request');
  this._stream = stream;
  stream.headers(headers);
  this.pipe(stream);

  var response = new IncomingMessage(stream, 'RESPONSE', logger);
  response.once('ready', this.emit.bind(this, 'response', response));
};

ClientRequest.prototype._fallback = function _fallback(request) {
  this._log.info('Falling back to simple HTTPS');
  
  this._request = request;

  this.pipe(request);
};

// Agent
// -----

// [HTTP agents](http://nodejs.org/api/http.html#http_class_http_agent) are not yet supported,
// so every client request will create a new TCP stream.
