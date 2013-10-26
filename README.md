node-http2 with upgrade
=======================

This fork adds the option "Starting HTTP/2.0 for "http" URIs (http://tools.ietf.org/html/draft-ietf-httpbis-http2-06#section-3.2) to Gabor HTTP/2 server implementation (http://gabor.molnar.es/blog/categories/google-summer-of-code/) for node.js (https://github.com/molnarg/node-http2).


Status
------

The current version captures HTTP1.1 Upgrade events to switch to HTTP2. 

* Server: need to check the draft version received;
* Client: need to be tested with several streams in //.


Installation
------------

see node-http2

Upgrade implementation
----------------------

server side in Server constructor of http.js:
	// start the server as an HTTP1.1
	this._server = http.createServer();
	// capture the upgrade event in the server:
	this._server.on('upgrade', function(request, socket, header)
	// Store the HTTP1 request for Stream1 usage 
	upgradeRequest =  ...
	// Response to the 
	socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
	// UPGRADE the connection to HTTP2 when the Upgrade is achieved
	  self._start(socket);
   in connection.js processes the upgradeRequest as a inbound HEADERS frame 

client side in in Agent.prototype.request() of http.js:

	// prepare the HTTP1 Upgrade fields values 
	Serializer.SETTINGS({ settings: settings }, buffers);
	// prepare the HTTP1 upgrade query
	headers: { 'Http2-Settings': base64url(buffers[0]) }
	// sent the upgrade
	var query = http.get(query_options);
	// Capture the HTTP1 upgrade response 
	query.on('upgrade', function(res, socket, upgradeHead) {	
	// create the HTTP2 connection 
	var endpoint = new Endpoint(self._log, 'CLIENT', options.settings);
	// create Stream 1
	endpoint._connection._allocateId(stream);		
	// pipe the HTTP1 socket to the HTTP2 connection
	client_endpoint.pipe(socket).pipe(client_endpoint);


Examples
--------

see 

Activating the HTTP2 Upgrade in the client and the server of the example dir is very easy : 

set the 'HTTP2_PLAIN' and 'HTTP2_UPGRADE' environment variables to turn Upgrade on (i.e. remove 'HTTP2_UPGRADE' from the env variable set to use the direct mode ...) .


Development dependencies
------------------------

There's one additionnal library you will need to have installed : base64url
