node-http2
==========

An HTTP/2 server implementation for node.js, developed as a [Google Summer of Code project][1].

[1]: https://google-melange.appspot.com/gsoc/project/google/gsoc2013/molnarg/5001

Status
------

I post weekly status updates [on my blog][2]. Short version: an example server and client can be
run. A more node-like API, more documentation and tests are coming soon.

[2]: http://gabor.molnar.es/blog/categories/google-summer-of-code/

Installation
------------

Using npm:

```
npm install http2
```

API
---

API documentation is coming later, when the public API becomes usable.

Examples
--------

An example server (serving up static files from its own directory) and client are available in the
example directory.

Running the server:

```bash
$ node ./example/server.js
Listening on localhost:8080, serving up files from ./example
```

Downloading the server's source code from the server (the downloaded content gets pumped out to the
standard error output):

```bash
$ node ./example/client.js 'http://localhost:8080/server.js' 2>/tmp/server.js
```

Development
-----------

### Development dependencies ###

There's a few library you will need to have installed to do anything described in the following
sections. After installing node-http2, run `npm install` in its directory to install development
dependencies.

Used libraries:

* [mocha][3] for tests
* [chai][4] for assertions
* [istanbul][5] for code coverage analysis
* [docco][6] for developer documentation
* [bunyan][7] for logging

[3]: http://visionmedia.github.io/mocha/
[4]: http://chaijs.com/
[5]: https://github.com/gotwarlost/istanbul
[6]: http://jashkenas.github.io/docco/
[7]: https://github.com/trentm/node-bunyan

### Developer documentation ###

The developer documentation is located in the `doc` directory. The docs are usually updated only
before releasing a new version. To regenerate them manually, run `npm run-script prepublish`.
There's a hosted version which is located [here](http://molnarg.github.io/node-http2/doc/).

### Running the tests ###

It's easy, just run `npm test`. The tests are written in BDD style, so they are a good starting
point to understand the code.

### Test coverage ###

To generate a code coverage report, run `npm test --coverage`. Code coverage summary as of version
0.0.6:
```
Statements   : 91.18% ( 775/850 )
Branches     : 84.69% ( 249/294 )
Functions    : 88.03% ( 103/117 )
Lines        : 91.18% ( 775/850 )
```

There's a hosted version of the detailed (line-by-line) coverage report [here][8].

[8]: http://molnarg.github.io/node-http2/coverage/lcov-report/lib/

### Logging ###

Logging is turned off by default. To turn it on, set the `HTTP2_LOG` environment variable to
`fatal`, `error`, `warn`, `info`, `debug` or `trace` (the logging level). Log output is in JSON
format, and can be pretty printed using the [bunyan][7] command line tool.

For example, running the test client with debug level logging output:

```
HTTP2_LOG=debug node ./example/client.js 'http://localhost:8080/server.js' 2>/tmp/server.js | bunyan -o short
```

License
-------

The MIT License

Copyright (C) 2013 Gábor Molnár <gabor@molnar.es>
