node-http2
==========

An HTTP/2 server implementation for node.js, developed as a [Google Summer of Code project]
(https://google-melange.appspot.com/gsoc/project/google/gsoc2013/molnarg/5001).

Status
------

I post weekly status updates [on my blog](http://gabor.molnar.es/blog/categories/google-summer-of-code/).
Short version: main missing items are:

* prioritization
  (issue [#19](https://github.com/molnarg/node-http2/issues/19)
  and [#20](https://github.com/molnarg/node-http2/issues/20))
* ALPN support for negotiating HTTP/2 over TLS (it's done with NPN for now)
  (issue [#5](https://github.com/molnarg/node-http2/issues/5))
* Upgrade mechanism to start HTTP/2 over unencrypted channel
  (issue [#4](https://github.com/molnarg/node-http2/issues/4))

Installation
------------

Using npm:

```
npm install http2
```

API
---

The API is very similar to the [standard node.js HTTPS API](http://nodejs.org/api/https.html). The
goal is the perfect API compatibility, with additional HTTP2 related extensions (like server push).

Detailed API documentation is maintained in the `lib/http.js` file and is [available as HTML]
(http://molnarg.github.io/node-http2/doc/http.html) as well.

Examples
--------

### Using as a server ###

```javascript
var http2 = require('http2');

var options = {
  key: fs.readFileSync('./example/localhost.key'),
  cert: fs.readFileSync('./example/localhost.crt')
};

http2.createServer(options, function(request, response) {
  response.end('Hello world!');
}).listen(8080);
```

### Using as a client ###

```javascript
var http2 = require('http2');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var request = http2.get('https://gabor.molnar.es:8080/');

request.on('response', function(response) {
  response.pipe(process.stdout);
});
```

### Simple static file server ###

An simple static file server serving up content from its own directory is available in the `example`
directory. Running the server:

```bash
$ node ./example/server.js
Listening on localhost:8080, serving up files from ./example
```

### Simple command line client ###

An example client is also available. Downloading the server's own source code from the server:

```bash
$ node ./example/client.js 'https://localhost:8080/server.js' 2>/tmp/server.js
```

### Server push ###

For a server push example, see the source code of the example
[server](blob/master/example/server.js) and [client](blob/master/example/client.js).

Development
-----------

### Development dependencies ###

There's a few library you will need to have installed to do anything described in the following
sections. After installing/cloning node-http2, run `npm install` in its directory to install
development dependencies.

Used libraries:

* [mocha](http://visionmedia.github.io/mocha/) for tests
* [chai](http://chaijs.com/) for assertions
* [istanbul](https://github.com/gotwarlost/istanbul) for code coverage analysis
* [docco](http://jashkenas.github.io/docco/) for developer documentation
* [bunyan](https://github.com/trentm/node-bunyan) for logging

For pretty printing logs, you will also need a global install of bunyan (`npm install -g bunyan`).

### Developer documentation ###

The developer documentation is located in the `doc` directory. The docs are usually updated only
before releasing a new version. To regenerate them manually, run `npm run-script prepublish`.
There's a hosted version which is located [here](http://molnarg.github.io/node-http2/doc/).

### Running the tests ###

It's easy, just run `npm test`. The tests are written in BDD style, so they are a good starting
point to understand the code.

### Test coverage ###

To generate a code coverage report, run `npm test --coverage` (which runs very slowly, be patient).
Code coverage summary as of version 0.0.6:
```
Statements   : 91.18% ( 775/850 )
Branches     : 84.69% ( 249/294 )
Functions    : 88.03% ( 103/117 )
Lines        : 91.18% ( 775/850 )
```

There's a hosted version of the detailed (line-by-line) coverage report
[here](http://molnarg.github.io/node-http2/coverage/lcov-report/lib/).

### Logging ###

Logging is turned off by default. To turn it on, set the `HTTP2_LOG` environment variable to
`fatal`, `error`, `warn`, `info`, `debug` or `trace` (the logging level). Log output is in JSON
format, and can be pretty printed using the [bunyan][7] command line tool.

For example, running the test client with debug level logging output:

```
HTTP2_LOG=debug node ./example/client.js 'http://localhost:8080/server.js' 2>/tmp/server.js | bunyan
```

Contributors
------------

Code contributions are always welcome! People who contributed to node-http2 so far:

* Nick Hurley
* Mike Belshe

Special thanks to Google for financing the development of this module as part of their [Summer of
Code program](https://developers.google.com/open-source/soc/), and Nick Hurley of Mozilla, my GSoC
mentor, who helps with regular code review and technical advices.

License
-------

The MIT License

Copyright (C) 2013 Gábor Molnár <gabor@molnar.es>
