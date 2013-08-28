// [node-http2][homepage] is an [HTTP/2 (draft 04)][http2] implementation for [node.js][node].
//
// The main building blocks are mainly [node.js streams][node-stream] that are connected through
// pipes.
//
// The main components are:
//
// * [http.js](http.html): the top layer that presents an API very similar to the standard node.js
//   [HTTPS module][node-https] (which is in turn very similar to the [HTTP module][node-http]).
//
// * [Endpoint](endpoint.html): represents an HTTP/2 endpoint (client or server). It's
//   responsible for the the first part of the handshake process (sending/receiving the
//   [connection header][http2-connheader]) and manages other components (framer, compressor,
//   connection, streams) that make up a client or server.
//
// * [Connection](connection.html): multiplexes the active HTTP/2 streams, manages connection
//   lifecycle and settings, and responsible for enforcing the connection level limits (flow
//   control, initiated stream limit)
//
// * [Stream](stream.html): implementation of the [HTTP/2 stream concept](http2-stream).
//   Implements the [stream state machine][http2-streamstate] defined by the standard, provides
//   management methods and events for using the stream (sending/receiving headers, data, etc.),
//   and enforces stream level constraints (flow control, sending only legal frames).
//
// * [Flow](flow.html): implements flow control for Connection and Stream as parent class.
//
// * [Compressor and Decompressor](compressor.html): compression and decompression of HEADER and
//   PUSH_PROMISE frames
//
// * [Serializer and Deserializer](framer.html): the lowest layer in the stack that transforms
//   between the binary and the JavaScript object representation of HTTP/2 frames
//
// [homepage]:            https://github.com/molnarg/node-http2
// [http2]:               http://tools.ietf.org/html/draft-ietf-httpbis-http2-04
// [http2-connheader]:    http://tools.ietf.org/html/draft-ietf-httpbis-http2-04#section-3.5
// [http2-stream]:        http://tools.ietf.org/html/draft-ietf-httpbis-http2-04#section-5
// [http2-streamstate]:   http://tools.ietf.org/html/draft-ietf-httpbis-http2-04#section-5.1
// [node]:                http://nodejs.org/
// [node-stream]:         http://nodejs.org/api/stream.html
// [node-https]:          http://nodejs.org/api/https.html
// [node-http]:           http://nodejs.org/api/http.html

module.exports   = require('./http');

/*
                    API user

                 |            ^
                 |            |
 +---------------|------------|--------------------------------------------------------+
 |               |            |        Server/Agent                                    |
 |               v            |                                                        |
 |          +----------+ +----------+                                                  |
 |          | Outgoing | | Incoming |                                                  |
 |          | req/res. | | req/res. |                                                  |
 |          +----------+ +----------+                                                  |
 |               |            ^                                                        |
 |   +-----------|------------|---------------------------------------+   +-----       |
 |   |           |            |   Endpoint                            |   |            |
 |   |           |            |                                       |   |            |
 |   |   +-------|------------|-----------------------------------+   |   |            |
 |   |   |       |            |  Connection                       |   |   |            |
 |   |   |       v            |                                   |   |   |            |
 |   |   |  +-----------------------+  +--------------------      |   |   |            |
 |   |   |  |        Stream         |  |         Stream      ...  |   |   |            |
 |   |   |  +-----------------------+  +--------------------      |   |   |            |
 |   |   |       |            ^              |            ^       |   |   |            |
 |   |   |       v            |              v            |       |   |   |            |
 |   |   |       +------------+--+--------+--+------------+- ...  |   |   |            |
 |   |   |                       |        ^                       |   |   |            |
 |   |   |                       |        |                       |   |   |      ...   |
 |   |   +-----------------------|--------|-----------------------+   |   |            |
 |   |                           |        |                           |   |            |
 |   |                           v        |                           |   |            |
 |   |   +--------------------------+  +--------------------------+   |   |            |
 |   |   |        Compressor        |  |       Decompressor       |   |   |            |
 |   |   +--------------------------+  +--------------------------+   |   |            |
 |   |                           |        ^                           |   |            |
 |   |                           v        |                           |   |            |
 |   |   +--------------------------+  +--------------------------+   |   |            |
 |   |   |        Serializer        |  |       Deserializer       |   |   |            |
 |   |   +--------------------------+  +--------------------------+   |   |            |
 |   |                           |        ^                           |   |            |
 |   +---------------------------|--------|---------------------------+   +-----       |
 |                               |        |                                            |
 |                               v        |                                            |
 |   +----------------------------------------------------------------+   +-----       |
 |   |                           TCP stream                           |   |      ...   |
 |   +----------------------------------------------------------------+   +-----       |
 |                                                                                     |
 +-------------------------------------------------------------------------------------+

*/
