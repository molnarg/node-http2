node-http2
==========

An HTTP/2 server implementation for node.js, developed as a [Google Summer of Code project](https://google-melange.appspot.com/gsoc/project/google/gsoc2013/molnarg/5001).

Status
======

I post weekly status updates [on my blog](http://gabor.molnar.es/blog/categories/google-summer-of-code/). Short version: framing layer 70% ready.

Installation
============

Using npm:

```
npm install http2
```

Documentation
=============

The developer documentation is generated using [docco](http://jashkenas.github.io/docco/), and is located in the `doc` directory. API documentation is coming later.

Running the tests
=================

To run the tests, first install [mocha](http://visionmedia.github.io/mocha/) and [chai](http://visionmedia.github.io/mocha/) (`npm install mocha chai`) and then run `npm test`.

The tests are written in BDD style, so they are a good starting point to understand the code.

License
=======

The MIT License

Copyright (C) 2013 Gábor Molnár <gabor@molnar.es>

