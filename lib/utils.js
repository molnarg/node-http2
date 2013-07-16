// Concatenate an array of buffers into a new buffer
exports.concat = function concat(buffers) {
  var size = 0;
  for (var i = 0; i < buffers.length; i++) {
    size += buffers[i].length;
  }

  var concatenated = new Buffer(size);
  for (var cursor = 0, j = 0; j < buffers.length; cursor += buffers[j].length, j++) {
    buffers[j].copy(concatenated, cursor);
  }

  return concatenated;
};

// Cut `buffer` into chunks not larger than `size`
exports.cut = function cut(buffer, size) {
  var chunks = [];
  var cursor = 0;
  do {
    var chunk_size = Math.min(size, buffer.length - cursor);
    chunks.push(buffer.slice(cursor, cursor + chunk_size));
    cursor += chunk_size;
  } while(cursor < buffer.length);
  return chunks;
};

// Shallow copy inspired by underscore's [clone](http://underscorejs.org/#clone)
exports.shallow_copy = function shallow_copy(object) {
  var clone = {};
  for (var key in object) {
    clone[key] = object[key];
  }
  return object;
};

// Placeholder no-op function
function noop() {}
exports.noop = noop;

// No-op dummy logger
exports.nolog = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop
};
