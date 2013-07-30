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
    var chunkSize = Math.min(size, buffer.length - cursor);
    chunks.push(buffer.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  } while(cursor < buffer.length);
  return chunks;
};

// Shallow copy inspired by underscore's [clone](http://underscorejs.org/#clone)
exports.shallowCopy = function shallowCopy(object) {
  var clone = {};
  for (var key in object) {
    clone[key] = object[key];
  }
  return clone;
};

// Placeholder no-op function
function noop() {}
exports.noop = noop;
