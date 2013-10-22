node-http2 with upgrade
=======================

This fork adds HTTP1 upgrade to Gabor HTTP/2 server implementation (http://gabor.molnar.es/blog/categories/google-summer-of-code/) for node.js1

Status
------

The current version uses nodejs http API to capture HTTP1.1 Upgrade events. 

Installation
------------

see node-http2

Source code
-----------

server side:
    in http.js:
	// start the server as an HTTP1.1
	this._server = http.createServer();
	// capture of the upgrade in the server:
	this._server.on('upgrade', function(request, socket, header)
	// Store the HTTP1 request for Stream1 usage 
	socket.upgradeRequest =  ...
	// Response to the 
	socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
	// UPGRADE the connection to HTTP2 when the Upgrade is achieved
	  self._start(socket);
   in connection.js
	// push the upgradeRequest in a inbound HEADERS frame 
	this.write(upgradeRequest);

client side in ... connection.js:
	// prepare the HTTP1 Upgrade fields values 
	Serializer.SETTINGS({ settings: settings }, buffers);
	// prepare the HTTP1 query
	headers: { 'Http2-Settings': base64url(buffers[0]) }
	// sent the upgrade
	var query = http.get(query_options);
	// Capture the HTTP1 upgrade response 
	query.on('upgrade', function(res, socket, upgradeHead) {	
	// create the HTTP2 connection
	var client_endpoint = new Endpoint('CLIENT', settings);
	// pipe the HTTP1 socket to the HTTP2 connection
	client_endpoint.pipe(socket).pipe(client_endpoint);

Examples
--------

Examples include a client and a server.
Running the server with Upgrade: 
	node .\client.js scheme://server:port/path noplain nossl
	It serves up static files from its own directory.

Running the client with Upgrade:
	node .\client.js scheme://server:port/path noplain nossl

other modes
	upgrade mode:	noplain	nossl
	direct mode:	plain 	nossl
	ssl mode:	noplain ssl (to be tested again)

Development dependencies
------------------------

There's one additionnal library you will need to have installed : base64url


