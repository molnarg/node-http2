node-http2
==========

An HTTP/2 server implementation for node.js, developed as a [Google Summer of Code project][1].

[1]: https://google-melange.appspot.com/gsoc/project/google/gsoc2013/molnarg/5001

Status
======

I post weekly status updates [on my blog][2]. Short version: framing layer, compression and stream
implementation is ready. Connection handling is next.

[2]: http://gabor.molnar.es/blog/categories/google-summer-of-code/

Installation
============

Using npm:

```
npm install http2
```

API
===

API documentation is coming later, when the public API becomes usable.

Development
===========

Development dependencies
------------------------

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

Developer documentation
-----------------------

The developer documentation is located in the `doc` directory. The docs are usually updated only
before releasing a new version. To regenerate them manually, run `npm run-script prepublish`.

Running the tests
-----------------

It's easy, just run `npm test`. The tests are written in BDD style, so they are a good starting
point to understand the code.

To generate a code coverage report, run `npm test --coverage`. Code coverage summary as of version
0.0.5:
```
Statements   : 86.94% ( 539/620 )
Branches     : 70.59% ( 168/238 )
Functions    : 89.16% ( 74/83 )
Lines        : 86.94% ( 539/620 )
```

Logging
-------

Logging is turned off by default. To turn it on, set the `HTTP2_LOG` environment variable to
`fatal`, `error`, `warn`, `info`, `debug` or `trace` (the logging level). Log output is in JSON
format, and can be pretty printed using the [bunyan][7] command line tool.

For example, to run the tests with very verbose logging output:

```
HTTP2_LOG=trace npm test | bunyan -o short
```

License
=======

The MIT License

Copyright (C) 2013 Gábor Molnár <gabor@molnar.es>
